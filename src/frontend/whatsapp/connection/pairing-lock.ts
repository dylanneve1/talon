/**
 * Coordination between the WhatsApp frontend's connection loop and a
 * manual pairing attempt (driven from Telegram via the core broker).
 *
 * Only one Baileys socket may own the auth dir at a time: a manual
 * pairing socket racing the frontend's reconnect loop corrupts the
 * half-registered credentials and burns pairing attempts against
 * WhatsApp's rate limits. The loop checks `isManualPairingActive()`
 * before every connect and parks; a completed pairing fires the
 * completion event so a parked loop wakes immediately instead of on its
 * next poll.
 */

let active = false;
const completionCallbacks = new Set<() => void>();

export function acquireManualPairing(): boolean {
  if (active) return false;
  active = true;
  return true;
}

export function releaseManualPairing(paired: boolean): void {
  active = false;
  if (paired) {
    for (const cb of completionCallbacks) cb();
  }
}

export function isManualPairingActive(): boolean {
  return active;
}

/** Returns an unsubscribe function. */
export function onPairingComplete(cb: () => void): () => void {
  completionCallbacks.add(cb);
  return () => completionCallbacks.delete(cb);
}

/** Test seam. */
export function resetPairingLock(): void {
  active = false;
  completionCallbacks.clear();
}
