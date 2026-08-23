/**
 * Pairing policy for the WhatsApp frontend.
 *
 * Pairing is strictly on demand (Telegram's /whatsapp pair → the core
 * pairing broker): the frontend never requests codes by itself. Every
 * automatic retry policy tried here — including a 30-minute backoff
 * ladder — still burned pairing codes against WhatsApp's rate limit
 * until every scan failed with "couldn't connect device". What remains
 * is the close-code taxonomy the connection loop reads.
 */

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
