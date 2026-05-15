/**
 * Delivered-text tracking — shared by all backends to enforce the
 * scratchpad-by-contract.
 *
 * The output stream of every backend is private scratchpad by design.
 * Final replies must be routed through a delivery tool: `end_turn(text=...)`,
 * `send(type="text", text=...)`, or `react(...)`. Anything written into the
 * model's natural-language output is dropped from the user-visible chat.
 *
 * This module owns three pieces:
 *
 *   1. `normalizeForDedupe` — fold whitespace + emoji + case for fuzzy
 *      equality (so a trailing-prose duplicate of `end_turn(text=...)` content
 *      is recognised even with minor formatting differences).
 *   2. `isDuplicateOfDelivered` — substring match against a list of
 *      already-delivered normalized texts.
 *   3. `captureDeliveredText` — pull the user-facing `text` arg out of an
 *      `end_turn` / `send(type="text")` tool call so it lands in the
 *      delivered list. Tool names arrive MCP-prefixed
 *      (`mcp__telegram-tools__end_turn`) — the helper strips the prefix
 *      before checking.
 *
 * Backends should call `captureDeliveredText` for every observed tool_use,
 * then `isDuplicateOfDelivered` on any trailing prose before deciding
 * whether to surface a flow violation.
 */

import { stripMcpPrefix } from "../../core/tools/index.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** Texts shorter than this are exempt from duplicate-detection — small
 * legitimate replies like "ok" or "👍" must never get suppressed. */
const MIN_DEDUP_LENGTH = 10;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Normalize text for fuzzy comparison — trim, lowercase, collapse whitespace,
 * strip emoji. The output is suitable for substring-containment checks but
 * not for cryptographic equality.
 */
export function normalizeForDedupe(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when `candidate` is substantively the same as any string in
 * `deliveredNorms`. "Substantively" means one contains the other after
 * normalization, and both are at least `MIN_DEDUP_LENGTH` chars.
 *
 * Empty `deliveredNorms` → always false (nothing to compare against).
 * Short `candidate` → always false (preserve "ok" / "thanks" / single emoji).
 */
export function isDuplicateOfDelivered(
  candidate: string,
  deliveredNorms: readonly string[],
): boolean {
  if (deliveredNorms.length === 0) return false;
  const norm = normalizeForDedupe(candidate);
  if (norm.length < MIN_DEDUP_LENGTH) return false;
  return deliveredNorms.some(
    (d) =>
      d.length >= MIN_DEDUP_LENGTH && (norm.includes(d) || d.includes(norm)),
  );
}

/**
 * Pull a user-facing `text` argument out of a tool call if the tool is a
 * known text-delivery tool. Returns the normalized form on a successful
 * extraction, `undefined` otherwise.
 *
 * Recognised:
 *   - `end_turn({ text: "..." })`
 *   - `send({ type: "text", text: "..." })`
 *
 * Other tools (including `react`, `send(type=photo)`, etc.) are ignored —
 * they don't deliver model-authored prose so they can't duplicate it.
 */
export function captureDeliveredText(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const bareName = stripMcpPrefix(toolName);
  let text: string | undefined;
  if (bareName === "end_turn" && typeof input.text === "string") {
    text = input.text;
  } else if (
    bareName === "send" &&
    input.type === "text" &&
    typeof input.text === "string"
  ) {
    text = input.text;
  }
  if (!text) return undefined;
  const norm = normalizeForDedupe(text);
  return norm || undefined;
}
