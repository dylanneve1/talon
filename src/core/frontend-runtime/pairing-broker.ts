/**
 * Frontend-pairing broker — how one frontend drives another's device
 * pairing without importing it.
 *
 * Concretely: WhatsApp needs a human to scan a QR / enter a code, and
 * the human is reachable on Telegram. Frontends must not import each
 * other, so this core seam (baileys-free, grammy-free) carries the
 * handshake: the WhatsApp side registers a provider at composition time,
 * the Telegram command consumes it on demand.
 *
 * Born from an outage: automatic re-pairing loops burned ~30 codes in
 * 80 minutes and WhatsApp rate-limited the account ("couldn't connect
 * device" on every scan). Pairing must be a deliberate act that happens
 * exactly when the human is holding the phone — one bounded attempt per
 * command, zero background retries.
 */

export type PairingAttempt = {
  /** PNG bytes of the QR to scan, when the flow produced one. */
  qrPng?: Uint8Array;
  /** Phone-number pairing code, when the account is configured for it. */
  code?: string;
  /** Resolves with the outcome of THIS attempt (bounded, never hangs). */
  result: Promise<PairingOutcome>;
  /** Abort the attempt early (user cancelled, command timed out). */
  cancel: () => void;
};

export type PairingOutcome =
  | { ok: true; identity: string }
  | { ok: false; reason: "expired" | "failed" | "cancelled"; detail?: string };

export type PairingProvider = {
  /** Human-readable frontend name ("WhatsApp"). */
  label: string;
  /** True when the frontend is already linked and connected. */
  isLinked: () => boolean;
  /** Start ONE bounded pairing attempt. Rejects if one is already running. */
  begin: () => Promise<PairingAttempt>;
};

let provider: PairingProvider | null = null;

export function registerPairingProvider(p: PairingProvider | null): void {
  provider = p;
}

export function getPairingProvider(): PairingProvider | null {
  return provider;
}
