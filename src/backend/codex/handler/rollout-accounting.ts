/**
 * Rollout-JSONL usage accounting for one Codex turn.
 *
 * Codex's `turn.completed.usage` is CUMULATIVE across every API call in
 * the turn — never in the per-turn units the shared stream state (and
 * everything downstream: /status, the companion's per-message counts)
 * speaks. The rollout JSONL's totals diffed against the pre-turn baseline
 * are this turn's real usage; that is the ONLY authoritative source. The
 * SDK figure is a last-resort fallback when the rollout can't be read,
 * and it overstates multi-call turns.
 *
 * The same baseline serves the throttled mid-turn poll (live /status) and
 * the final settlement, which the success path and the terminal-failure
 * path both run so failed turns account for the tokens they burned.
 */

import type { Usage } from "@openai/codex-sdk";
import {
  pushLiveUsage,
  recordTokens,
  type StreamState,
} from "../../shared/index.js";
import { CODEX_LIVE_POLL_INTERVAL_MS } from "../constants.js";
import {
  readLastRolloutSnapshot,
  type CodexRolloutSnapshot,
} from "../token-usage.js";

type RolloutTotals = NonNullable<CodexRolloutSnapshot["totals"]>;

export type RolloutAccounting = {
  /** Thread id once `thread.started` lands; polls are no-ops before it. */
  threadId: string | undefined;
  /** Throttled mid-turn rollout tail — fire-and-forget, never throws. */
  pollLive(): void;
  /** Final authoritative settlement; `usage` is the SDK's fallback figure. */
  settle(usage: Usage | null): Promise<void>;
};

/**
 * Capture the cumulative token totals BEFORE the turn runs.
 * `total_token_usage` accumulates across the whole session file, so this
 * turn's usage = post-turn totals minus this baseline. Fresh threads have
 * no rollout yet → zero baseline. `null` = resumed thread whose baseline
 * couldn't be read.
 */
export async function createRolloutAccounting(inputs: {
  state: StreamState;
  sessionId: string | undefined;
}): Promise<RolloutAccounting> {
  const { state } = inputs;
  const baseline: RolloutTotals | null = inputs.sessionId
    ? ((await readLastRolloutSnapshot(inputs.sessionId).catch(() => null))
        ?.totals ?? null)
    : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  let pollInFlight = false;
  let lastPollAt = 0;

  const accounting: RolloutAccounting = {
    threadId: undefined,

    // The Codex CLI appends a `token_count` event to the rollout JSONL
    // after every API call, so tailing it during the turn gives live
    // context-fill / token / API-call stats long before `turn.completed`.
    // In-flight guard — never blocks the event loop.
    pollLive() {
      if (!accounting.threadId || pollInFlight) return;
      const now = Date.now();
      if (now - lastPollAt < CODEX_LIVE_POLL_INTERVAL_MS) return;
      pollInFlight = true;
      lastPollAt = now;
      readLastRolloutSnapshot(accounting.threadId)
        .then((snap) => {
          if (!snap) return;
          applyContext(state, snap);
          // Same delta-vs-baseline math as the final settlement, which
          // recomputes and overwrites — a torn mid-turn read can't
          // corrupt the committed numbers.
          if (snap.totals && baseline) {
            state.sdkInputTokens = Math.max(
              0,
              snap.totals.inputTokens - baseline.inputTokens,
            );
            state.sdkOutputTokens = Math.max(
              0,
              snap.totals.outputTokens - baseline.outputTokens,
            );
            state.sdkCacheRead = Math.max(
              0,
              snap.totals.cachedInputTokens - baseline.cachedInputTokens,
            );
          }
          pushLiveUsage(state);
        })
        .catch(() => {})
        .finally(() => {
          pollInFlight = false;
        });
    },

    async settle(usage) {
      const last = accounting.threadId
        ? await readLastRolloutSnapshot(accounting.threadId).catch(() => null)
        : null;
      if (last) applyContext(state, last);
      if (last?.totals && baseline) {
        recordTokens(state, {
          inputTokens: last.totals.inputTokens - baseline.inputTokens,
          outputTokens: last.totals.outputTokens - baseline.outputTokens,
          cacheRead: last.totals.cachedInputTokens - baseline.cachedInputTokens,
          cacheWrite: 0, // Codex doesn't report cache writes
        });
      } else if (usage) {
        recordTokens(state, {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheRead: usage.cached_input_tokens,
          cacheWrite: 0, // Codex doesn't report cache writes
        });
      }
    },
  };
  return accounting;
}

function applyContext(state: StreamState, snap: CodexRolloutSnapshot): void {
  if (snap.usage) {
    state.contextTokens = snap.usage.contextTokens;
    if (snap.usage.contextWindow) {
      state.contextWindow = snap.usage.contextWindow;
    }
  }
  if (typeof snap.numApiCalls === "number") {
    state.numApiCalls = snap.numApiCalls;
  }
}
