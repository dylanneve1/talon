/** Query/body coercions shared by the bridge's route handlers. */

/**
 * Longest device id a client may claim (`?deviceId=…`). Matches the
 * registry's own id cap — a longer id can never name a real device, and the
 * claim is held for the life of a connection, so it stays a bounded key.
 */
const MAX_DEVICE_ID_CHARS = 128;

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * The `deviceId` a mesh client claims on `/events` and `/devices/file`.
 * Undefined when absent or blank — every consumer treats "no claim" as the
 * legacy case, so an empty string must never look like a claimed id.
 */
export function deviceIdParam(url: URL): string | undefined {
  const raw = (url.searchParams.get("deviceId") ?? "").trim();
  return raw ? raw.slice(0, MAX_DEVICE_ID_CHARS) : undefined;
}

/** Parse a positive-integer query param; undefined when absent/invalid. */
export function asPositiveInt(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A client's reference to a file it already uploaded. */
export type AttachmentRef = { url?: string; path?: string };

/**
 * Coerce the `attachments` array on a `/send` body to reference shape. Only
 * the identifying fields are read: name, size and type are whatever the
 * daemon recorded when it wrote the file, never what the client claims now.
 */
export function asAttachmentRefs(v: unknown): AttachmentRef[] {
  if (!Array.isArray(v)) return [];
  const refs: AttachmentRef[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const url = asString(row.url);
    const path = asString(row.path);
    if (url || path) refs.push({ url, path });
  }
  return refs;
}
