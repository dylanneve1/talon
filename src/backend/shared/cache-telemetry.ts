/**
 * Prompt-cache telemetry — the numbers needed to tell whether Talon's
 * prompt cache is actually working, and why not when it isn't.
 *
 * Motivation (see docs/memory-persona-plan.md §3.6): the obvious lever for a
 * sparse-traffic chat bot would be a 1-hour cache TTL, but
 * `@anthropic-ai/claude-agent-sdk` exposes no cache-control surface at all —
 * it owns `cache_control` placement internally. So the only levers Talon has
 * are (a) keeping the prompt prefix byte-stable and (b) keeping it small,
 * and the only way to know which one is costing money is to measure.
 *
 * Four things are measured here, each answering a question the aggregate
 * `cache=NN%` on the accounting line cannot:
 *
 *   1. **Cross-turn vs within-turn hits.** An agentic turn makes many model
 *      requests; every one after the first reads the prefix the first one
 *      just paid for. So a 97% aggregate hit rate is compatible with *every
 *      turn* re-writing the whole prefix. The turn's FIRST request is the
 *      only one that reports whether the previous turn's cache survived —
 *      that is the number that tracks cost.
 *   2. **Tool-set churn.** Tool definitions render BEFORE the system prompt,
 *      so any change to the tool array invalidates the system prompt and the
 *      whole message history with it. A stable prompt behind an unstable
 *      tool list buys nothing, and Talon's per-chat MCP servers are exactly
 *      the shape that can shift mid-session.
 *   3. **Lookback-window risk.** A cache breakpoint searches back at most
 *      `CACHE_LOOKBACK_BLOCKS` content blocks for a prior entry. A turn that
 *      emits more blocks than that can leave the *next* turn's breakpoint
 *      unable to find anything — a silent miss with no error.
 *   4. **Sub-minimum prompts.** Below a model-specific token floor nothing
 *      caches, and the API reports no error. Talon's chat prompts clear every
 *      floor; its one-shot prompts (dream, heartbeat, cron) may not.
 *
 * Everything here is pure except `noteToolFingerprint`, which keeps a small
 * per-chat map so it can name what changed rather than just that something
 * did.
 */

import { logWarn } from "../../util/log.js";

// ── Per-turn cache stats ────────────────────────────────────────────────────

/**
 * One model request's usage, as the SDK reports it in
 * `result.usage.iterations`. Fields are optional because a given provider
 * may omit any of them; absent is treated as zero.
 */
export type CacheIteration = {
  readonly input_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
};

/** Cache behaviour for one user-visible turn. */
export type TurnCacheStats = {
  /** Model requests the SDK made inside this turn. */
  readonly modelRequests: number;
  /** Cache read on the turn's FIRST request — did the last turn's prefix live? */
  readonly firstRead: number;
  /** Cache written by the turn's first request. */
  readonly firstWrite: number;
  /** Cache read across every request in the turn. */
  readonly totalRead: number;
  /** Cache written across every request in the turn. */
  readonly totalWrite: number;
};

/**
 * What the turn's first request says about the previous turn's cache.
 *
 *   - `hit`  — the prefix survived; this turn read it instead of paying for it.
 *   - `miss` — the prefix was gone and had to be re-written. The expensive case,
 *              and the one a TTL shorter than the gap between turns produces.
 *   - `none` — nothing was cached either way: below the model's cacheable
 *              minimum, or a provider that doesn't cache at all.
 */
export type CrossTurnVerdict = "hit" | "miss" | "none";

/**
 * Fold a turn's per-request usage into cache stats. Returns undefined when
 * the provider reported no iterations — the caller then logs nothing rather
 * than inventing a verdict from aggregate totals it can't attribute.
 */
export function turnCacheStats(
  iterations: readonly CacheIteration[] | undefined,
): TurnCacheStats | undefined {
  if (!iterations || iterations.length === 0) return undefined;
  const first = iterations[0]!;
  let totalRead = 0;
  let totalWrite = 0;
  for (const it of iterations) {
    totalRead += it.cache_read_input_tokens ?? 0;
    totalWrite += it.cache_creation_input_tokens ?? 0;
  }
  return {
    modelRequests: iterations.length,
    firstRead: first.cache_read_input_tokens ?? 0,
    firstWrite: first.cache_creation_input_tokens ?? 0,
    totalRead,
    totalWrite,
  };
}

/** Classify the turn's first request. See {@link CrossTurnVerdict}. */
export function crossTurnVerdict(stats: TurnCacheStats): CrossTurnVerdict {
  if (stats.firstRead > 0) return "hit";
  if (stats.firstWrite > 0) return "miss";
  return "none";
}

/**
 * Compact suffix for the per-turn accounting line, e.g.
 * `xturn=miss reqs=11 rw=8.0`. Deliberately terse and space-delimited so a
 * week of logs can be parsed without a schema:
 *
 *   - `xturn` — the cross-turn verdict; the field that tracks cost.
 *   - `reqs`  — model requests in the turn; explains a high aggregate hit
 *               rate that isn't saving anything.
 *   - `rw`    — total read ÷ total write. Above ~1 the turn amortised its
 *               write; at or below it, the write dominated.
 */
export function formatTurnCache(stats: TurnCacheStats): string {
  const parts = [
    `xturn=${crossTurnVerdict(stats)}`,
    `reqs=${stats.modelRequests}`,
  ];
  if (stats.totalWrite > 0) {
    parts.push(`rw=${(stats.totalRead / stats.totalWrite).toFixed(1)}`);
  }
  return parts.join(" ");
}

// ── Lookback window ────────────────────────────────────────────────────────

/**
 * How far back a cache breakpoint searches for a prior entry, in content
 * blocks. A turn that emits more than this can prevent the NEXT turn from
 * finding any cache to read.
 */
export const CACHE_LOOKBACK_BLOCKS = 20;

/**
 * Rough content-block count for a turn from its tool-call count. Each tool
 * call is a `tool_use` block plus a `tool_result` block, and the assistant
 * text around them adds at least one more — so `2n + 1` is a floor, not an
 * estimate. Used only to decide whether to warn, never to report a number.
 */
export function estimateTurnBlocks(toolCalls: number): number {
  return Math.max(0, toolCalls) * 2 + 1;
}

/** True when a turn plausibly emitted more blocks than a breakpoint looks back. */
export function exceedsLookbackWindow(toolCalls: number): boolean {
  return estimateTurnBlocks(toolCalls) > CACHE_LOOKBACK_BLOCKS;
}

// ── Cacheable minimum ──────────────────────────────────────────────────────

/**
 * Minimum cacheable prefix, in tokens, by model. Below this nothing is
 * cached and the API reports no error — `cache_creation_input_tokens` is
 * simply 0.
 *
 * The floor is NOT monotonic across generations (512 on the newest models,
 * 4096 on Opus 4.6 and Haiku 4.5), so it can't be inferred from a version
 * number. Longest match wins, so `sonnet-4-6` is checked before `sonnet`.
 *
 * Bare aliases resolve only where Talon's catalog leaves no ambiguity:
 * `haiku` is Haiku 4.5 (and carries the largest floor, making it the most
 * likely to silently not cache). Ambiguous aliases — `opus`, `sonnet`,
 * `default` — deliberately return undefined: a warning that fires on the
 * wrong model teaches people to ignore warnings.
 */
const CACHE_MINIMUMS: readonly (readonly [string, number])[] = [
  ["fable-5", 512],
  ["mythos-5", 512],
  ["opus-5", 512],
  ["opus-4-8", 1024],
  ["sonnet-5", 1024],
  ["sonnet-4-6", 1024],
  ["sonnet-4-5", 1024],
  ["opus-4-1", 1024],
  ["opus-4-7", 2048],
  ["mythos-preview", 2048],
  ["opus-4-6", 4096],
  ["opus-4-5", 4096],
  ["haiku-4-5", 4096],
  ["haiku", 4096],
];

/**
 * The cacheable-prefix floor for a model, or undefined when the model string
 * doesn't unambiguously identify one.
 */
export function cacheMinimumTokens(model: string): number | undefined {
  const m = model.toLowerCase();
  let best: { key: string; min: number } | undefined;
  for (const [key, min] of CACHE_MINIMUMS) {
    if (!m.includes(key)) continue;
    if (!best || key.length > best.key.length) best = { key, min };
  }
  return best?.min;
}

/** Cheap tokenizer-free estimate (~4 chars/token), matching soul/projector. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Warn when a prompt is too small to be cacheable on its model. No-op when
 * the model's floor is unknown or the prompt clears it. `label` names the
 * caller (e.g. `"dream"`) so the warning points somewhere.
 */
export function warnIfBelowCacheMinimum(
  label: string,
  model: string,
  prompt: string,
): void {
  const min = cacheMinimumTokens(model);
  if (min === undefined) return;
  const estimated = estimateTokens(prompt);
  if (estimated >= min) return;
  logWarn(
    "agent",
    `[${label}] prompt ~${estimated} tokens is below ${model}'s ${min}-token ` +
      `cacheable minimum — nothing will be cached for this run`,
  );
}

// ── Tool-set fingerprint ───────────────────────────────────────────────────

/**
 * Per-chat fingerprint of the last tool set seen. Bounded so a long-lived
 * process with many chats can't grow it without limit; eviction is
 * insertion-ordered, and a false "changed" warning after eviction is
 * cheaper than unbounded retention.
 */
const MAX_TRACKED_CHATS = 256;
const lastToolSets = new Map<string, readonly string[]>();

/** Stable fingerprint for a tool set: sorted, deduped names. */
export function toolFingerprint(
  builtinTools: readonly string[],
  mcpServerNames: readonly string[],
): readonly string[] {
  return [
    ...new Set([...builtinTools, ...mcpServerNames.map((n) => `mcp:${n}`)]),
  ].sort();
}

/**
 * Record this turn's tool set for a chat and warn when it differs from the
 * previous turn's. Returns true when a change was detected.
 *
 * Tools render before the system prompt, so a mid-session change invalidates
 * the system prompt and every cached message after it — the most expensive
 * cache event available, and invisible in aggregate hit-rate numbers.
 */
export function noteToolFingerprint(
  chatId: string,
  fingerprint: readonly string[],
): boolean {
  const previous = lastToolSets.get(chatId);

  if (lastToolSets.size >= MAX_TRACKED_CHATS && !previous) {
    const oldest = lastToolSets.keys().next().value;
    if (oldest !== undefined) lastToolSets.delete(oldest);
  }
  lastToolSets.set(chatId, fingerprint);

  if (!previous) return false;
  if (
    previous.length === fingerprint.length &&
    previous.every((t, i) => t === fingerprint[i])
  ) {
    return false;
  }

  const before = new Set(previous);
  const after = new Set(fingerprint);
  const added = fingerprint.filter((t) => !before.has(t));
  const removed = previous.filter((t) => !after.has(t));
  logWarn(
    "agent",
    `[${chatId}] tool set changed mid-session — invalidates the whole prompt ` +
      `cache for this chat` +
      (added.length ? ` (+${added.join(",")})` : "") +
      (removed.length ? ` (-${removed.join(",")})` : ""),
  );
  return true;
}

/** Drop all tracked fingerprints (tests / explicit reset). */
export function resetToolFingerprints(): void {
  lastToolSets.clear();
}
