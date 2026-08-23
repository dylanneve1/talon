/**
 * Pairing-recovery policy for the WhatsApp frontend.
 *
 * When WhatsApp unlinks the device (stream conflict `device_removed`,
 * a manual unlink, an account ban), recovery needs a human: someone must
 * enter a pairing code on the phone. The old loop treated a logout like
 * a network blip — wipe auth, reconnect immediately, request a fresh
 * code, time out, repeat — which generated a new code every ~2½ minutes
 * forever (26 codes in 80 minutes on the live deployment), each one
 * invalidating the last, all of them visible only in the daemon log.
 * That cadence is also exactly the shape WhatsApp rate-limits.
 *
 * Policy, kept pure here so it is testable without a socket:
 *   - retry pairing on a growing delay (quick first retry, 30-min cap),
 *   - surface each fresh code to the admin over a live frontend, but
 *     after the first few, at most one notification per hour — each
 *     notification always carries the CURRENT code.
 */

/** Delay before pairing attempt `attempt` (1-based, i.e. after `attempt` failures). */
export function nextPairingDelayMs(failedAttempts: number): number {
  if (failedAttempts <= 0) return 0;
  const LADDER = [5_000, 5 * 60_000, 10 * 60_000, 20 * 60_000];
  const CAP = 30 * 60_000;
  return LADDER[failedAttempts - 1] ?? CAP;
}

/** First codes always notify; afterwards at most one per hour. */
export const PAIRING_NOTIFY_FREE_CODES = 3;
export const PAIRING_NOTIFY_MIN_GAP_MS = 60 * 60_000;

export function shouldNotifyPairingCode(
  codesIssued: number,
  lastNotifiedAt: number | undefined,
  now: number = Date.now(),
): boolean {
  if (codesIssued <= PAIRING_NOTIFY_FREE_CODES) return true;
  if (lastNotifiedAt === undefined) return true;
  return now - lastNotifiedAt >= PAIRING_NOTIFY_MIN_GAP_MS;
}
