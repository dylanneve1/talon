/**
 * Admin notification seam — a way for any subsystem to reach the human
 * operator on their primary chat (adminUserId, usually Telegram).
 *
 * Core cannot import frontends, so the composition root injects the
 * delivery function at boot (bootstrap.ts, next to the plan-alerts
 * wiring, which does the same thing privately). Unwired — early boot,
 * tests, terminal mode with no admin — notifications degrade to a log
 * line rather than throwing.
 *
 * First consumer: WhatsApp pairing. When WhatsApp unlinks the device,
 * recovery needs a human to type a pairing code into the phone — a code
 * that previously only ever appeared in the daemon log, which nobody
 * watches. Alerts about a dead frontend must travel over a LIVE one.
 */

import { log, logWarn } from "./../util/log.js";

let deliver: ((text: string) => Promise<void>) | null = null;

/** Wire (or clear) the delivery function. Called by the composition root. */
export function setAdminNotifier(
  fn: ((text: string) => Promise<void>) | null,
): void {
  deliver = fn;
}

/**
 * Send `text` to the admin chat. Never throws; returns whether delivery
 * was attempted (false = no notifier wired).
 */
export async function notifyAdmin(text: string): Promise<boolean> {
  if (!deliver) {
    logWarn(
      "notify",
      `No admin notifier wired; dropping: ${text.slice(0, 120)}`,
    );
    return false;
  }
  try {
    await deliver(text);
    return true;
  } catch (err) {
    log(
      "notify",
      `Admin notification failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}
