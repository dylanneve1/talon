/**
 * System-prompt assembly for backends.
 *
 * Three concerns live here:
 *
 *   1. **Per-session prompt snapshots** — each chat session gets a frozen
 *      system prompt for its whole lifetime, keyed by the session's
 *      `createdAt` epoch. Without this, the global `config.systemPrompt`
 *      was rebuilt in place whenever *any* chat started a fresh session
 *      (or `/reset` ran warm-up), and every other in-flight session
 *      silently picked up the new string on its next turn — invalidating
 *      the provider's prompt-cache prefix for the entire context.
 *      Observed cost before the fix: 60-90k cache-write tokens on turns
 *      that should have written 2-8k.
 *
 *   2. `appendBackendSuffix` — every backend appends its own delivery
 *      override text to the system prompt (Codex says "use end_turn /
 *      send / react"; OpenCode/Kilo legacy say "return text as the
 *      reply"). Suffixes are constant per backend, so they join the
 *      *static* part of the prompt.
 *
 *   3. The static/dynamic split (see `SystemPromptParts` in config.ts)
 *      is preserved end-to-end so the Claude SDK backend can place
 *      `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` between the cacheable prefix
 *      and the volatile suffix.
 *
 * Session-lifetime semantics: a session's prompt is rebuilt exactly once,
 * when the snapshot for its epoch is first requested (new session, or
 * first turn after a daemon restart). Later memory.md edits or plugin
 * prompt changes land in the *next* session — the same contract Claude
 * Code applies to its own system prompt. `clearSystemPromptSnapshots()`
 * exists for the deliberate exceptions (plugin reload).
 */

import {
  rebuildSystemPrompt,
  joinSystemPromptParts,
  type SystemPromptParts,
  type TalonConfig,
} from "../../util/config.js";
import { getPluginPromptAdditions } from "../../core/plugin/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Inputs for `prepareSystemPrompt`. */
export type PrepareSystemPromptInputs = {
  /** The live Talon config (mutated in place when rebuilding). */
  config: TalonConfig;
  /** Number of previous turns in this session — 0 triggers rebuild. */
  previousTurns: number;
  /** Optional backend-specific suffix to append after the rebuilt prompt. */
  backendSuffix?: string;
  /**
   * Chat ID for per-session snapshotting. When provided together with
   * `sessionEpoch`, the prompt is frozen for the session's lifetime.
   * When omitted, falls back to the legacy rebuild-on-first-turn
   * behaviour (used by tests and one-shot paths).
   */
  chatId?: string;
  /**
   * Session creation timestamp (`session.createdAt`). Changes when a
   * session is reset, which is exactly when the prompt should be
   * rebuilt.
   */
  sessionEpoch?: number;
};

/** A prepared system prompt: joined text plus the cache-boundary split. */
export type PreparedSystemPrompt = {
  /** Full prompt as a single string (static + dynamic, suffix included). */
  text: string;
  /** Static, cross-session cacheable part (includes backend suffix). */
  staticText: string;
  /** Volatile part (workspace listing, daily-memory pointer). */
  dynamicText: string;
};

// ── Per-session snapshot store ──────────────────────────────────────────────

type Snapshot = {
  epoch: number;
  suffix: string;
  prepared: PreparedSystemPrompt;
};

/**
 * chatId → frozen prompt for the session epoch. In-memory only: after a
 * daemon restart the first turn of each session re-freezes (one
 * unavoidable cache re-write per session per restart — identical to the
 * pre-snapshot behaviour).
 */
const snapshots = new Map<string, Snapshot>();

/**
 * Bound the store so thousands of short-lived chat sessions can't grow
 * it unbounded. Eviction is insertion-ordered (effectively oldest
 * session first); at this size eviction is unreachable in practice for
 * a single-operator deployment.
 */
const MAX_SNAPSHOTS = 256;

/**
 * Drop all session snapshots. Call when prompt inputs change out from
 * under live sessions *on purpose* — e.g. plugin reload, where the next
 * turn of every chat should see the new plugin prompt additions even at
 * the cost of one cache re-write per session.
 */
export function clearSystemPromptSnapshots(): void {
  snapshots.clear();
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Prepare the final system prompt the backend should send to its SDK.
 *
 * With `chatId` + `sessionEpoch`: returns the frozen per-session prompt,
 * building (and freezing) it on first request for that epoch. Without
 * them: legacy behaviour — rebuild the global prompt when
 * `previousTurns === 0` and return the current global value.
 */
export function prepareSystemPrompt(
  inputs: PrepareSystemPromptInputs,
): PreparedSystemPrompt {
  const suffix = (inputs.backendSuffix ?? "").trim();

  if (inputs.chatId !== undefined && inputs.sessionEpoch !== undefined) {
    const cached = snapshots.get(inputs.chatId);
    if (
      cached &&
      cached.epoch === inputs.sessionEpoch &&
      cached.suffix === suffix
    ) {
      return cached.prepared;
    }

    // New session (or first touch after restart / backend switch):
    // rebuild the global template once, then freeze it for this session.
    rebuildSystemPrompt(inputs.config, getPluginPromptAdditions());
    const prepared = buildPrepared(inputs.config, suffix);

    if (snapshots.size >= MAX_SNAPSHOTS && !snapshots.has(inputs.chatId)) {
      const oldest = snapshots.keys().next().value;
      if (oldest !== undefined) snapshots.delete(oldest);
    }
    snapshots.set(inputs.chatId, {
      epoch: inputs.sessionEpoch,
      suffix,
      prepared,
    });
    return prepared;
  }

  // Legacy path — no session identity available.
  if (inputs.previousTurns === 0) {
    rebuildSystemPrompt(inputs.config, getPluginPromptAdditions());
  }
  return buildPrepared(inputs.config, suffix);
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a `PreparedSystemPrompt` from the config's current prompt parts.
 *
 * The backend suffix joins the *static* part: delivery contracts are
 * constant per backend, and keeping the dynamic tail last preserves the
 * longest possible cacheable prefix for providers with automatic
 * prefix caching (OpenAI-side backends get this for free from the
 * ordering even without an explicit boundary marker).
 */
function buildPrepared(
  config: TalonConfig,
  suffix: string,
): PreparedSystemPrompt {
  // Configs constructed by older tests may lack `systemPromptParts`;
  // treat the whole string as static in that case.
  const parts: SystemPromptParts = config.systemPromptParts ?? {
    staticText: config.systemPrompt ?? "",
    dynamicText: "",
  };
  const staticText = appendBackendSuffix(parts.staticText, suffix);
  const dynamicText = parts.dynamicText.trim();
  return {
    text: joinSystemPromptParts({ staticText, dynamicText }),
    staticText,
    dynamicText,
  };
}
