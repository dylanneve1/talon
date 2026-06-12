/**
 * Adaptive effort router — heuristic per-turn reasoning-effort
 * selection. No LLM calls: a cheap text classifier buckets each
 * incoming message into light / standard / heavy and maps the bucket
 * onto the active model's supported effort levels.
 *
 * Scope rules (all must hold for a turn to be routed):
 *
 *   1. `adaptiveEffort: true` in talon.json (opt-in, default off).
 *   2. The chat has NO explicit `/effort` pick — a user's stored
 *      effort always wins; adaptive routing only replaces the
 *      "backend default" case.
 *   3. The resolved model advertises effort levels. Models without a
 *      registered effort surface are left alone.
 *
 * Mechanism: the dispatcher computes the routed effort before
 * `runChatTurn` and parks it in a turn-scoped override slot; the
 * backends that consume effort (claude-sdk, codex) read the slot via
 * `getTurnEffortOverride` at the same point they read
 * `chatSettings.effort`. Per-chat turn serialization in the
 * dispatcher guarantees at most one live override per chat, and the
 * dispatcher clears the slot in `finally` so background one-shots
 * and later turns never inherit it.
 */

import { getChatSettings } from "../../storage/chat-settings.js";
import { REASONING_LEVEL_ORDER } from "./reasoning-levels.js";
import { logDebug } from "../../util/log.js";
import type { ReasoningEffortLevel } from "../types.js";
import type { ModelRef } from "../agent-runtime/model-ref.js";

export type EffortTier = "light" | "standard" | "heavy";

// ── Router state ────────────────────────────────────────────────────────────

let enabled = false;

/** Turn-scoped overrides — set by the dispatcher, read by backends. */
const turnOverrides = new Map<string, ReasoningEffortLevel>();

export function initEffortRouter(cfg: { enabled: boolean }): void {
  enabled = cfg.enabled;
}

export function isEffortRouterEnabled(): boolean {
  return enabled;
}

export function setTurnEffortOverride(
  chatId: string,
  effort: ReasoningEffortLevel,
): void {
  turnOverrides.set(chatId, effort);
}

/** The routed effort for the chat's in-flight turn, if any. */
export function getTurnEffortOverride(
  chatId: string,
): ReasoningEffortLevel | undefined {
  return turnOverrides.get(chatId);
}

export function clearTurnEffortOverride(chatId: string): void {
  turnOverrides.delete(chatId);
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Keywords whose presence marks a message as reasoning-heavy. Matched
 * case-insensitively on word boundaries.
 */
const HEAVY_PATTERNS: readonly RegExp[] = [
  /\b(debug|diagnose|analy[sz]e|investigate|root.cause)\b/i,
  /\b(architect|design|refactor|implement|optimi[sz]e)\b/i,
  /\b(prove|derive|calculate|compute|estimate)\b/i,
  /\b(compare|trade.?offs?|pros and cons|evaluate)\b/i,
  /\b(plan|strategy|step.by.step|in depth|thorough)\b/i,
  /\b(why (does|is|did|would|won't|can't)|explain how)\b/i,
  /```/, // fenced code block
];

/**
 * Patterns marking a message as light chatter: greetings, acks,
 * reactions. Anchored — a long message that merely starts with
 * "thanks" is not light.
 */
const LIGHT_PATTERNS: readonly RegExp[] = [
  /^(hi|hey|hello|yo|sup|good (morning|night|evening))\b[\s!.,]*$/i,
  /^(thanks|thank you|thx|ty|cheers|nice|cool|great|lol|lmao|haha+|ok(ay)?|sure|yes|no|yep|nope|got it|sounds good)\b[\s!.,]*$/i,
  /^[\p{Emoji}\s]+$/u,
];

const LIGHT_MAX_CHARS = 80;
const HEAVY_MIN_CHARS = 600;

/**
 * Bucket a message by how much reasoning it likely needs. Pure
 * function of the text — deliberately conservative: anything not
 * clearly light or clearly heavy is standard.
 */
export function classifyEffortTier(text: string): EffortTier {
  const trimmed = text.trim();
  if (trimmed.length <= LIGHT_MAX_CHARS) {
    if (LIGHT_PATTERNS.some((p) => p.test(trimmed))) return "light";
  }
  if (trimmed.length >= HEAVY_MIN_CHARS) return "heavy";
  if (HEAVY_PATTERNS.some((p) => p.test(trimmed))) return "heavy";
  // Multiple distinct questions usually mean a multi-part answer.
  if ((trimmed.match(/\?/g) ?? []).length >= 3) return "heavy";
  return "standard";
}

// ── Tier → level mapping ────────────────────────────────────────────────────

/** Preferred level per tier; snapped to what the model supports. */
const TIER_TARGET: Record<EffortTier, ReasoningEffortLevel> = {
  light: "low",
  standard: "medium",
  heavy: "high",
};

/**
 * Snap a target level to the nearest level the model supports,
 * walking outward through `REASONING_LEVEL_ORDER` (prefers the
 * nearest lower level on ties — cheaper beats pricier). Returns
 * undefined when the model supports no levels.
 */
export function snapToSupportedLevel(
  target: ReasoningEffortLevel,
  supported: readonly ReasoningEffortLevel[],
): ReasoningEffortLevel | undefined {
  if (supported.length === 0) return undefined;
  if (supported.includes(target)) return target;
  const idx = REASONING_LEVEL_ORDER.indexOf(target);
  for (let dist = 1; dist < REASONING_LEVEL_ORDER.length; dist++) {
    const lower = REASONING_LEVEL_ORDER[idx - dist];
    if (lower && supported.includes(lower)) return lower;
    const higher = REASONING_LEVEL_ORDER[idx + dist];
    if (higher && supported.includes(higher)) return higher;
  }
  return undefined;
}

// ── Routing entry point ─────────────────────────────────────────────────────

/**
 * Compute the routed effort for one turn, or undefined when the turn
 * should not be routed (router disabled, user has an explicit effort
 * pick, or the model has no effort surface). Does NOT set the
 * override — the dispatcher owns the set/clear lifecycle.
 */
export function routeEffortForTurn(
  chatId: string,
  text: string,
  ref: ModelRef | null,
): ReasoningEffortLevel | undefined {
  if (!enabled) return undefined;
  if (getChatSettings(chatId).effort) return undefined; // user pick wins
  const supported = ref?.effortLevels;
  if (!supported || supported.length === 0) return undefined;

  const tier = classifyEffortTier(text);
  const level = snapToSupportedLevel(TIER_TARGET[tier], supported);
  if (!level) return undefined;
  logDebug(
    "effort-router",
    `chat=${chatId} tier=${tier} → effort=${level} (model=${ref.id})`,
  );
  return level;
}
