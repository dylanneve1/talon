/**
 * System-prompt assembly for backends.
 *
 * Pulls together three behaviours that previously lived in handler bodies:
 *
 *   1. `rebuildOnFirstTurn` — when a session is brand-new (turns === 0),
 *      re-execute `rebuildSystemPrompt` so the model sees fresh memory
 *      values, identity stanza, plugin contributions, and workspace
 *      listing. Without this, plugin hot-reloads only land on the next
 *      session, and memory updates between sessions are invisible.
 *
 *   2. `appendBackendSuffix` — every backend appends its own delivery
 *      override text to the system prompt (Kilo says "use end_turn /
 *      send / react"; OpenCode/Kilo legacy say "return text as the
 *      reply"). Centralising the append step makes it trivial to swap
 *      delivery contracts per backend without copy-pasting concatenation.
 *
 *   3. `formatBackendSystemPrompt` — combines (1) and (2) with proper
 *      blank-line separation and a defensive trim, returning the final
 *      string the backend should hand to its SDK.
 *
 * Backends usually call `prepareSystemPrompt(...)` once per turn, which
 * does the first-turn rebuild + suffix append in one step.
 */

import { rebuildSystemPrompt, type TalonConfig } from "../../util/config.js";
import { getPluginPromptAdditions } from "../../core/plugin.js";

// ── Public API ──────────────────────────────────────────────────────────────

/** Inputs for `prepareSystemPrompt`. */
export type PrepareSystemPromptInputs = {
  /** The live Talon config (mutated in place when rebuilding). */
  config: TalonConfig;
  /** Number of previous turns in this session — 0 triggers rebuild. */
  previousTurns: number;
  /** Optional backend-specific suffix to append after the rebuilt prompt. */
  backendSuffix?: string;
};

/**
 * Prepare the final system prompt the backend should send to its SDK.
 *
 * Rebuilds the system prompt for fresh sessions (so memory + plugin
 * additions are fresh) and appends any backend-specific delivery
 * override. The result is normalized: trimmed, with at most one blank
 * line separating sections.
 */
export function prepareSystemPrompt(inputs: PrepareSystemPromptInputs): string {
  if (inputs.previousTurns === 0) {
    rebuildSystemPrompt(inputs.config, getPluginPromptAdditions());
  }
  return appendBackendSuffix(inputs.config.systemPrompt, inputs.backendSuffix);
}

/**
 * Append a backend-specific suffix to a system prompt. Idempotent: passing
 * an empty/undefined suffix returns the input unchanged.
 *
 * Separator: two newlines between base and suffix when both are non-empty.
 */
export function appendBackendSuffix(
  base: string,
  suffix: string | undefined,
): string {
  const trimmedBase = (base ?? "").trim();
  const trimmedSuffix = (suffix ?? "").trim();
  if (!trimmedSuffix) return trimmedBase;
  if (!trimmedBase) return trimmedSuffix;
  return `${trimmedBase}\n\n${trimmedSuffix}`;
}
