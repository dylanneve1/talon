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

// ── Close-code taxonomy ─────────────────────────────────────────────────────

/**
 * What one Baileys `connection: "close"` means for the reconnect loop.
 * Ported from how OpenClaw's connection controller reads DisconnectReason
 * — the old handler knew only "loggedOut or not", which turned pairing
 * success (515) into an anonymous reconnect and let another client's
 * takeover (440) start a reconnect fight.
 */
export type CloseDisposition =
  | { kind: "pairing-accepted" } // 515: code entered — reconnect NOW, same creds
  | { kind: "replaced" } // 440: another socket owns the session — back off hard
  | { kind: "logged-out"; midPairing: boolean } // 401: dead creds
  | { kind: "reconnect" }; // everything else: transient

export function classifyClose(
  statusCode: number | undefined,
  credsRegistered: boolean,
): CloseDisposition {
  switch (statusCode) {
    case 515: // DisconnectReason.restartRequired — expected right after pairing
      return { kind: "pairing-accepted" };
    case 440: // DisconnectReason.connectionReplaced
      return { kind: "replaced" };
    case 401: // DisconnectReason.loggedOut
    case 403: // DisconnectReason.forbidden — account-level, same recovery
      return { kind: "logged-out", midPairing: !credsRegistered };
    default:
      return { kind: "reconnect" };
  }
}

/** How long to sit out after a 440 — another client owns the session. */
export const REPLACED_BACKOFF_MS = 60_000;
