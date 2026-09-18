/**
 * Shape coercion for the member-facing WhatsApp actions: model-supplied user
 * references → JIDs, and Baileys' several `fetchStatus` result shapes → text.
 */

/**
 * Coerce a user reference the model supplied — bare number, JID, or the
 * numeric id from a member listing — into a WhatsApp user JID.
 */
export function toUserJid(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.includes("@")) return raw;
  const digits = raw.replace(/[^0-9]/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
}

/**
 * Pull the about text out of a `fetchStatus` result. Baileys has
 * returned both a bare object and a one-element array across versions,
 * and the payload itself nests `status` either as a string or as
 * `{ status }` — accept all four shapes rather than guess one.
 */
export function readStatusText(result: unknown): string | undefined {
  const entry = (Array.isArray(result) ? result[0] : result) as
    { status?: string | { status?: string } } | undefined;
  return typeof entry?.status === "string"
    ? entry.status
    : entry?.status?.status;
}
