/**
 * Id coercion for the Telegram action handlers.
 */

/**
 * Telegram/GramJS APIs expect numeric IDs. `snowflakeOrIdSchema` normalizes IDs
 * to digit-strings (so 17-19 digit Discord snowflakes survive validation), so a
 * Telegram message/reply/offset ID can arrive here as a string. Coerce it back
 * to a positive integer: Telegram IDs are well within 2^53, so this is lossless.
 * Returns undefined for missing / non-positive / non-integer values.
 */
export function toPositiveId(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
