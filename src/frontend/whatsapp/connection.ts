/**
 * The Baileys socket lifecycle: one socket per `connectOnce`, the
 * reconnect/backoff loop around it, and the parked state a logged-out or
 * never-paired account waits in until `/whatsapp pair` links it.
 */

import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import makeWASocket, { type AuthenticationState, type WASocket } from "baileys";
import qrcode from "qrcode-terminal";
import { log, logError, logWarn } from "../../util/log.js";
import { dirs } from "../../util/paths.js";
import { notifyAdmin } from "../../core/notify.js";
import { useAtomicAuthState } from "./auth-state.js";
import { bareId } from "./identity.js";
import { handleInbound } from "./inbound.js";
import { classifyClose, isPaired, REPLACED_BACKOFF_MS } from "./pairing.js";
import { isManualPairingActive, onPairingComplete } from "./pairing-lock.js";
import {
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  type WhatsAppRuntime,
} from "./runtime.js";
import { makeWaLogger } from "./wa-logger.js";

/** What the connection loop should do after a socket ends. */
type ConnectOutcome = "reconnect" | "logged-out" | "unpaired" | "stop";

function bindInbound(runtime: WhatsAppRuntime, socket: WASocket): void {
  socket.ev.on("messages.upsert", ({ messages, type }) => {
    // "notify" is a live message. "append" is everything delivered out
    // of band — chiefly messages QUEUED WHILE THE DAEMON WAS DOWN
    // (Baileys marks offline-queued nodes as append), but also our own
    // sends echoing back and newsletter posts, which handleInbound's
    // fromMe/allowlist gates drop. Dropping append wholesale meant any
    // message sent during a restart simply vanished: never recorded,
    // never answered. Appends are processed as catch-up: always
    // recorded, replied to only while fresh.
    if (type !== "notify" && type !== "append") return;
    const catchUp = type === "append";
    for (const msg of messages) {
      void handleInbound(runtime, msg, { catchUp }).catch((err) => {
        logError(
          "whatsapp",
          `inbound handler failed: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  });
}

function onQr(runtime: WhatsAppRuntime, qr: string): void {
  // The frontend NEVER requests pairing codes on its own — that
  // loop once burned ~30 codes in 80 minutes and rate-limited
  // the account. Pairing is on demand via /whatsapp pair
  // (core/pairing-broker.ts). The terminal QR stays for
  // foreground first-run setups without a Telegram admin.
  log(
    "whatsapp",
    "Not linked — pair on demand with /whatsapp pair (Telegram), " +
      "or scan below: WhatsApp → Linked devices → Link a device",
  );
  qrcode.generate(qr, { small: true });
  if (!runtime.unpairedNotified) {
    runtime.unpairedNotified = true;
    void notifyAdmin(
      "📱 WhatsApp is not linked. Send /whatsapp pair when you're " +
        "ready and I'll reply with a QR to scan.",
    );
  }
}

function onOpen(runtime: WhatsAppRuntime, socket: WASocket): void {
  // Both forms: a group can @-mention us by either.
  runtime.selfIds = [socket.user?.id, socket.user?.lid]
    .filter((id): id is string => Boolean(id))
    .map(bareId);
  runtime.reconnectDelay = RECONNECT_BASE_MS;
  if (runtime.unpairedNotified) {
    void notifyAdmin("✅ WhatsApp linked and connected.");
  }
  runtime.unpairedNotified = false;
  log(
    "whatsapp",
    `Connected as ${socket.user?.name ?? "?"} (${runtime.selfIds.join("/") || "?"})`,
  );
}

function onClose(
  runtime: WhatsAppRuntime,
  state: AuthenticationState,
  code: number | undefined,
): ConnectOutcome {
  if (runtime.stopping) return "stop";
  const disposition = classifyClose(code, state.creds.registered);
  switch (disposition.kind) {
    case "pairing-accepted":
      // 515 right after a pairing code/QR is SUCCESS, not an
      // error: WhatsApp requires one reconnect with the same
      // credentials to complete the login.
      log(
        "whatsapp",
        "Pairing accepted (515) — reconnecting to complete login",
      );
      runtime.reconnectDelay = RECONNECT_BASE_MS;
      return "reconnect";
    case "replaced":
      // Another socket owns this session (440). Fighting it with
      // an instant reconnect just steals the session back and
      // forth; sit out a full minute instead.
      logWarn(
        "whatsapp",
        "Connection replaced by another client (440) — backing off",
      );
      runtime.reconnectDelay = REPLACED_BACKOFF_MS;
      return "reconnect";
    case "logged-out":
      return "logged-out";
    default:
      // A socket that died without ever completing a login is a
      // pairing window that expired — reconnecting would just open QR
      // session after QR session against WhatsApp's servers.
      // Park instead; /whatsapp pair opens the next one.
      //
      // Test with isPaired, not creds.registered: a QR-linked session
      // never sets that flag, so the flag alone parks a healthy
      // session on its first ordinary disconnect.
      if (!isPaired(state.creds)) return "unpaired";
      log("whatsapp", `Connection closed (code ${code ?? "?"}) — reconnecting`);
      return "reconnect";
  }
}

/** One socket lifetime. Resolves with what the caller should do next. */
async function connectOnce(runtime: WhatsAppRuntime): Promise<ConnectOutcome> {
  // Atomic replacement for Baileys' useMultiFileAuthState — same disk
  // format, torn-write-proof (see auth-state.ts for why that matters).
  const { state, saveCreds } = await useAtomicAuthState(dirs.whatsappAuth);
  const socket = makeWASocket({
    auth: state,
    logger: makeWaLogger(),
    markOnlineOnConnect: false,
    // The account is a bot: announcing "online" would suppress the
    // phone's own notifications for the human who owns the number.
    //
    // 120s per QR/pairing ref — the default (60s + 20s refreshes) gave
    // a ~2½-minute socket lifetime in pairing mode, shorter than it
    // takes a human to pick up their phone and type the code.
    qrTimeout: 120_000,
    // OpenClaw's production timings: the Baileys 20s connect timeout
    // is tight on a loaded box, and a slightly faster keepalive spots
    // a dead transport sooner.
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
  });
  runtime.sock = socket;
  socket.ev.on("creds.update", saveCreds);
  bindInbound(runtime, socket);

  return new Promise((resolve) => {
    socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !state.creds.registered) onQr(runtime, qr);
      if (connection === "open") onOpen(runtime, socket);
      if (connection === "close") {
        const code = (
          lastDisconnect?.error as
            { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;
        resolve(onClose(runtime, state, code));
      }
    });
  });
}

/**
 * Wait until a manual pairing completes (event from pairing-lock) or
 * registered creds appear on disk, polling slowly. Resolves promptly
 * when the frontend is stopping.
 */
async function parkUntilPaired(runtime: WhatsAppRuntime): Promise<void> {
  while (!runtime.stopping) {
    if (!isManualPairingActive()) {
      try {
        const raw = await readFile(
          resolvePath(dirs.whatsappAuth, "creds.json"),
          "utf-8",
        );
        // Same trap as above: waiting on `registered` alone means a QR
        // re-link can never end the park, because that flag stays false.
        if (
          isPaired(
            JSON.parse(raw) as {
              registered?: boolean;
              me?: { id?: string } | null;
            },
          )
        )
          return;
      } catch {
        /* no creds yet — stay parked */
      }
    }
    const paired = await new Promise<boolean>((r) => {
      const off = onPairingComplete(() => {
        clearTimeout(timer);
        off();
        r(true);
      });
      const timer = setTimeout(() => {
        off();
        r(false);
      }, 30_000);
      timer.unref?.();
    });
    if (paired) return;
  }
}

/** The frontend's whole `start()`: connect, reconnect, park, until stopped. */
export async function runConnectionLoop(
  runtime: WhatsAppRuntime,
): Promise<void> {
  log("whatsapp", "WhatsApp frontend starting (Baileys multi-device)");
  while (!runtime.stopping) {
    // A manual pairing attempt owns the auth dir: two sockets on one
    // keypair corrupt it and burn rate-limited pairing attempts.
    if (isManualPairingActive()) {
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    let outcome: ConnectOutcome;
    try {
      outcome = await connectOnce(runtime);
    } catch (err) {
      logError(
        "whatsapp",
        `Socket error: ${err instanceof Error ? err.message : err}`,
      );
      outcome = "reconnect";
    }
    runtime.sock = null;
    if (outcome === "stop" || runtime.stopping) break;
    if (outcome === "logged-out") {
      // These credentials are dead — WhatsApp unlinked the device.
      // Wipe them and PARK. Re-pairing needs a human holding the
      // phone, so it happens strictly on demand (Telegram's
      // `/whatsapp pair`) — every automatic retry policy tried here,
      // including a 30-minute backoff ladder, still burned codes
      // against WhatsApp's rate limit until scans failed with
      // "couldn't connect device" for everyone.
      logWarn(
        "whatsapp",
        "Logged out by WhatsApp — parked until /whatsapp pair re-links",
      );
      void notifyAdmin(
        "⚠️ WhatsApp unlinked this device. When you're ready to " +
          "re-link, send /whatsapp pair and scan the QR I reply with. " +
          "Nothing is retried until then.",
      );
      rmSync(dirs.whatsappAuth, { recursive: true, force: true });
      await parkUntilPaired(runtime);
      runtime.reconnectDelay = RECONNECT_BASE_MS;
      continue;
    }
    if (outcome === "unpaired") {
      log("whatsapp", "Not paired — parked until /whatsapp pair links");
      await parkUntilPaired(runtime);
      runtime.reconnectDelay = RECONNECT_BASE_MS;
      continue;
    }
    await new Promise((r) => setTimeout(r, runtime.reconnectDelay));
    runtime.reconnectDelay = Math.min(
      runtime.reconnectDelay * 2,
      RECONNECT_MAX_MS,
    );
  }
  log("whatsapp", "WhatsApp connection loop ended");
}
