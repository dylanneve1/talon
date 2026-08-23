/**
 * Failure semantics for a WhatsApp turn, mirroring the Telegram queue
 * (frontend/telegram/handlers/queue.ts): a user-initiated stop settles
 * silently, a brief transient failure gets one retry, and anything else
 * is REPORTED IN THE CHAT. Before this existed the error went only to
 * the log — the WhatsApp user's message was marked read and then nothing
 * ever came back, which reads as being ignored.
 *
 * Split from index.ts so the policy is unit-testable without a Baileys
 * socket: the caller injects the turn and the delivery.
 */

import {
  classify,
  friendlyMessage,
  RETRY_ELAPSED_CAP_MS,
} from "../../core/errors.js";
import { log, logError } from "../../util/log.js";
import {
  recordError,
  recordMessageProcessed,
  recordMessageSettled,
} from "../../util/watchdog.js";

export type TurnRecoveryDeps = {
  chatId: string;
  senderName: string;
  runTurn: () => Promise<unknown>;
  /** Deliver a friendly error line into the chat. Must not throw. */
  sendErrorText: (text: string) => Promise<void>;
  /** Test seam for the retry pause; defaults to a real setTimeout. */
  wait?: (ms: number) => Promise<void>;
};

export async function runTurnWithRecovery(
  deps: TurnRecoveryDeps,
): Promise<void> {
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const startedAt = Date.now();
  try {
    await deps.runTurn();
    recordMessageProcessed();
  } catch (err) {
    const classified = classify(err);
    // A user-initiated /stop is an outcome, not a fault — the stop was
    // already acknowledged, so an error bubble here would contradict it.
    if (classified.reason === "stopped") {
      log("whatsapp", `[${deps.chatId}] turn stopped by user`);
      recordMessageSettled();
      return;
    }
    logError(
      "whatsapp",
      `[${deps.chatId}] [${deps.senderName}] ${classified.reason}: ${classified.message}`,
    );
    recordError(classified.message);

    // Retry once for transients (rate_limit, overloaded, network) — but
    // only when the failed attempt was brief. An attempt that already ran
    // for minutes won't be saved by a 2s pause, and turns serialize per
    // chat, so a blind retry doubles the stall for everything behind it.
    const attemptMs = Date.now() - startedAt;
    if (classified.retryable && attemptMs < RETRY_ELAPSED_CAP_MS) {
      const delayMs = classified.retryAfterMs ?? 2000;
      log(
        "whatsapp",
        `[${deps.chatId}] Retrying after ${classified.reason} (${delayMs}ms)...`,
      );
      try {
        await wait(delayMs);
        await deps.runTurn();
        recordMessageProcessed();
        return;
      } catch (retryErr) {
        const retryClassified = classify(retryErr);
        logError(
          "whatsapp",
          `[${deps.chatId}] Retry failed: ${retryClassified.message}`,
        );
        recordMessageSettled();
        await deps.sendErrorText(friendlyMessage(retryClassified));
        return;
      }
    }

    recordMessageSettled();
    await deps.sendErrorText(friendlyMessage(classified));
  }
}
