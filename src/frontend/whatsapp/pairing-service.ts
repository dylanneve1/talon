/**
 * One bounded, on-demand WhatsApp pairing attempt — the provider behind
 * `core/pairing-broker.ts`, invoked from Telegram's /whatsapp command.
 *
 * One command = one attempt: a fresh socket, the FIRST QR (rendered to
 * PNG for delivery as a photo) plus a phone-number code when configured,
 * a single ~2-minute window, then a definite outcome. No retries, no
 * background loops — the human re-runs the command when they're ready.
 * Entering a code / scanning ends with Baileys' 515 restartRequired,
 * which is SUCCESS: one same-creds reconnect completes the login.
 */

import { rmSync } from "node:fs";
import makeWASocket, { type WASocket } from "baileys";
import QRCode from "qrcode";
import type {
  PairingAttempt,
  PairingOutcome,
} from "../../core/pairing-broker.js";
import { log, logError } from "../../util/log.js";
import { dirs } from "../../util/paths.js";
import { useAtomicAuthState, flushAuthWrites } from "./auth-state.js";
import { classifyClose } from "./pairing.js";
import { acquireManualPairing, releaseManualPairing } from "./pairing-lock.js";
import { bareId } from "./identity.js";
import { makeWaLogger } from "./wa-logger.js";

/** How long one attempt may run before reporting "expired". */
const ATTEMPT_WINDOW_MS = 150_000;
/** How long we wait for the first QR before calling the attempt failed. */
const FIRST_QR_TIMEOUT_MS = 20_000;

export async function beginPairingAttempt(
  pairingNumber?: string,
): Promise<PairingAttempt> {
  if (!acquireManualPairing()) {
    throw new Error("A pairing attempt is already in progress");
  }

  let sock: WASocket | null = null;
  let settled = false;
  let paired = false;
  let resolveResult!: (o: PairingOutcome) => void;
  const result = new Promise<PairingOutcome>((r) => (resolveResult = r));

  const settle = (outcome: PairingOutcome) => {
    if (settled) return;
    settled = true;
    paired = outcome.ok;
    try {
      sock?.end(undefined);
    } catch {
      /* closed */
    }
    void flushAuthWrites().finally(() => releaseManualPairing(paired));
    resolveResult(outcome);
  };

  const windowTimer = setTimeout(
    () => settle({ ok: false, reason: "expired" }),
    ATTEMPT_WINDOW_MS,
  );
  windowTimer.unref?.();

  /** One socket generation; 515 recurses once with the same creds. */
  const connect = async (afterPairing: boolean): Promise<void> => {
    const { state, saveCreds } = await useAtomicAuthState(dirs.whatsappAuth);
    const socket = makeWASocket({
      auth: state,
      logger: makeWaLogger(),
      markOnlineOnConnect: false,
      qrTimeout: 120_000,
      connectTimeoutMs: 60_000,
    });
    sock = socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr && !afterPairing && !firstQr.done) {
        firstQr.done = true;
        firstQr.resolve(qr);
      }
      if (connection === "open") {
        const identity = bareId(socket.user?.id) || "unknown";
        log("whatsapp", `Manual pairing succeeded — linked as ${identity}`);
        settle({ ok: true, identity });
      }
      if (connection === "close") {
        const code = (
          lastDisconnect?.error as
            { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        const disposition = classifyClose(code, state.creds.registered);
        if (disposition.kind === "pairing-accepted" && !settled) {
          // Scan/code accepted — finish the login on the same creds.
          log("whatsapp", "Pairing accepted (515) — completing login");
          void connect(true).catch((err) =>
            settle({
              ok: false,
              reason: "failed",
              detail: err instanceof Error ? err.message : String(err),
            }),
          );
          return;
        }
        if (!settled) {
          settle({
            ok: false,
            reason: "expired",
            detail: `connection closed (code ${code ?? "?"})`,
          });
        }
      }
    });
    return;
  };

  const firstQr: {
    done: boolean;
    resolve: (qr: string) => void;
    promise: Promise<string>;
  } = (() => {
    let resolve!: (qr: string) => void;
    const promise = new Promise<string>((r) => (resolve = r));
    return { done: false, resolve, promise };
  })();

  try {
    // A half-registered keypair from an earlier abandoned attempt 401s
    // instantly; start clean. Registered creds are never wiped here —
    // begin() isn't offered when the account is already linked.
    rmSync(dirs.whatsappAuth, { recursive: true, force: true });
    await connect(false);

    const qrString = await Promise.race([
      firstQr.promise,
      new Promise<null>((r) => {
        const t = setTimeout(() => r(null), FIRST_QR_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    if (!qrString) {
      settle({ ok: false, reason: "failed", detail: "no QR from server" });
      clearTimeout(windowTimer);
      return {
        result,
        cancel: () => settle({ ok: false, reason: "cancelled" }),
      };
    }

    const qrPng = new Uint8Array(
      await QRCode.toBuffer(qrString, {
        type: "png",
        errorCorrectionLevel: "M",
        scale: 8,
        margin: 2,
      }),
    );

    let code: string | undefined;
    if (pairingNumber) {
      try {
        code = await sock!.requestPairingCode(bareId(pairingNumber));
      } catch (err) {
        // The QR still works; the code is a bonus.
        logError(
          "whatsapp",
          `pairing code request failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return {
      qrPng,
      ...(code ? { code } : {}),
      result,
      cancel: () => settle({ ok: false, reason: "cancelled" }),
    };
  } catch (err) {
    settle({
      ok: false,
      reason: "failed",
      detail: err instanceof Error ? err.message : String(err),
    });
    clearTimeout(windowTimer);
    return { result, cancel: () => {} };
  }
}
