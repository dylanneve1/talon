/**
 * Codex reasoning-effort vocabulary mapping.
 *
 * Talon's canonical `ReasoningEffortLevel` is a superset of what Codex's
 * `modelReasoningEffort` thread option accepts: `off` isn't expressible on a
 * reasoning model, and `max` is Claude-only. Both simply fall through to the
 * model's own default.
 *
 * This is pure vocabulary translation — the "does this model offer that
 * level?" question is answered by the caller (per-chat settings for an
 * interactive turn, `core/background/effort.ts` for heartbeat/dream) against
 * the model catalog's `supportedReasoningLevels`. Keeping the mapping here
 * means the chat path and the one-shot path can't drift apart.
 */

import type { ReasoningEffortLevel } from "../../core/types.js";

/** The levels Codex's `modelReasoningEffort` thread option accepts. */
export type CodexReasoningEffort = Exclude<ReasoningEffortLevel, "off" | "max">;

/**
 * Map a canonical level onto Codex's thread option, or undefined when Codex
 * has no way to express it (`off`, `max`, or nothing requested).
 */
export function toCodexReasoningEffort(
  level: ReasoningEffortLevel | undefined,
): CodexReasoningEffort | undefined {
  if (!level || level === "off" || level === "max") return undefined;
  return level;
}
