/**
 * Backend metric piping — one vocabulary for every backend.
 *
 * Before this module each backend hand-rolled its own counters:
 * claude-sdk and the remote-server family stripped MCP prefixes off
 * tool names, codex didn't (so `tool_calls.mcp__…` and
 * `tool_calls.send` counted the same tool twice under different
 * keys); only codex recorded per-turn tool/API histograms; and
 * openai-agents never counted flow-violation cap exhaustion. Cross-
 * backend comparisons were impossible because the names didn't line
 * up.
 *
 * ## Metric vocabulary
 *
 * Shared (no backend dimension — comparable across the fleet):
 *   - `queries_total`                      counter, one per user-visible turn
 *   - `response_latency_ms`                histogram
 *   - `tool_calls.<bare-name>`             counter, MCP prefix stripped
 *   - `tool_calls_per_turn`                histogram
 *   - `turns_with_tools_total`             counter
 *   - `api_calls_total` / `api_calls_per_turn`
 *   - `tokens.input_total` / `tokens.output_total`
 *     / `tokens.cache_read_total` / `tokens.cache_write_total`
 *   - `cache_hit_percent`                  histogram, per turn
 *   - `scratchpad.trailing_text_dropped` / `.flow_violation_retried`
 *     / `.flow_violation_cap_exhausted`
 *
 * Per-backend dimension (`backend.<id>.…`, id = BackendId):
 *   - `backend.<id>.queries`
 *   - `backend.<id>.response_latency_ms`   histogram
 *   - `backend.<id>.tool_calls`
 *   - `backend.<id>.turn_failed`
 *   - `backend.<id>.tokens.input` / `.output` / `.cache_read` / `.cache_write`
 *   - `backend.<id>.cache_hit_percent`     histogram
 *
 * Keep names LOW-CARDINALITY: the metrics store caps total keys at
 * 500. Tool names are bounded by the tool catalog; backend ids by the
 * registry. Never interpolate chat ids, model ids, or user input.
 */

import { incrementCounter, recordHistogram } from "../../util/metrics.js";
import { stripMcpPrefix } from "../../core/tools/index.js";
import { cacheHitPercent, type TokenUsageSnapshot } from "./usage.js";
import { clearLiveTurn, recordUsage } from "../../storage/sessions.js";

/**
 * Count one tool call. `toolName` may be raw from any backend —
 * MCP-prefixed (`mcp__telegram-tools__send`), server-prefixed
 * (`talon-tools-123_send`), or bare — it is normalised so every
 * backend lands on the same `tool_calls.<bare>` key.
 */
export function recordToolCall(toolName: string, backend?: string): void {
  incrementCounter(`tool_calls.${stripMcpPrefix(toolName)}`);
  if (backend) incrementCounter(`backend.${backend}.tool_calls`);
}

/** Per-turn rollup recorded once at the end of every chat turn. */
export type TurnMetricInputs = {
  /** Backend id, e.g. "claude", "codex", "kilo", "openai-agents", "opencode". */
  backend: string;
  durationMs: number;
  /** Tool calls observed this turn (omit when the backend can't count them). */
  toolCalls?: number;
  /** Upstream API calls this turn (omit when unknown). */
  apiCalls?: number;
  /** True when the turn ended in a delivered failure. */
  failed?: boolean;
  /**
   * Token usage for the turn — the same snapshot handlers persist via
   * `recordUsage()`. Omit when the backend can't report usage.
   */
  usage?: TokenUsageSnapshot;
};

/**
 * Record the uniform per-turn metric set. Replaces the per-backend
 * `recordHistogram("response_latency_ms")` + `incrementCounter
 * ("queries_total")` pairs (and codex's private `codex.*` family).
 */
export function recordTurnMetrics(inputs: TurnMetricInputs): void {
  recordHistogram("response_latency_ms", inputs.durationMs);
  recordHistogram(
    `backend.${inputs.backend}.response_latency_ms`,
    inputs.durationMs,
  );
  incrementCounter("queries_total");
  incrementCounter(`backend.${inputs.backend}.queries`);

  if (inputs.failed) incrementCounter(`backend.${inputs.backend}.turn_failed`);

  if (inputs.toolCalls !== undefined) {
    recordHistogram("tool_calls_per_turn", inputs.toolCalls);
    if (inputs.toolCalls > 0) incrementCounter("turns_with_tools_total");
  }
  if (inputs.apiCalls !== undefined && inputs.apiCalls > 0) {
    incrementCounter("api_calls_total", inputs.apiCalls);
    recordHistogram("api_calls_per_turn", inputs.apiCalls);
  }

  if (inputs.usage) {
    const u = inputs.usage;
    const b = `backend.${inputs.backend}`;
    incrementCounter("tokens.input_total", u.inputTokens);
    incrementCounter("tokens.output_total", u.outputTokens);
    incrementCounter("tokens.cache_read_total", u.cacheRead);
    incrementCounter("tokens.cache_write_total", u.cacheWrite);
    incrementCounter(`${b}.tokens.input`, u.inputTokens);
    incrementCounter(`${b}.tokens.output`, u.outputTokens);
    incrementCounter(`${b}.tokens.cache_read`, u.cacheRead);
    incrementCounter(`${b}.tokens.cache_write`, u.cacheWrite);
    // Only meaningful when the turn actually consumed input — an
    // all-zero snapshot (failed turn, usage-less backend) would skew
    // the distribution with hard zeros.
    if (u.inputTokens + u.cacheRead > 0) {
      const pct = cacheHitPercent(u);
      recordHistogram("cache_hit_percent", pct);
      recordHistogram(`${b}.cache_hit_percent`, pct);
    }
  }
}

/**
 * Terminal-failure accounting — call right before re-throwing a turn
 * that exhausted its retries.
 *
 * Historically every backend skipped BOTH `recordTurnMetrics` and
 * `recordUsage` when a turn errored: the tokens the failed turn burned
 * vanished from /status and /metrics, latency histograms only sampled
 * successes, and the live-turn overlay leaked until the next turn.
 * This helper closes all three gaps in one call:
 *
 *   - per-turn metrics with `failed: true` (also feeds
 *     `backend.<id>.turn_failed`)
 *   - session usage, but only when the stream actually reported tokens —
 *     an all-zero recordUsage would wipe the context display for no
 *     benefit
 *   - the live-turn overlay is always cleared
 *
 * NOT for retry paths: when a turn is retried, the recursive attempt
 * does its own accounting and this helper must not run for the outer
 * attempt (it would double-count the query).
 */
export function recordFailedTurnAccounting(inputs: {
  backend: string;
  chatId: string;
  durationMs: number;
  toolCalls?: number;
  apiCalls?: number;
  model?: string;
  usage: TokenUsageSnapshot;
  contextTokens?: number;
  contextWindow?: number;
}): void {
  recordTurnMetrics({
    backend: inputs.backend,
    durationMs: inputs.durationMs,
    toolCalls: inputs.toolCalls,
    apiCalls: inputs.apiCalls,
    failed: true,
    usage: inputs.usage,
  });
  const u = inputs.usage;
  const sawUsage =
    u.inputTokens + u.outputTokens + u.cacheRead + u.cacheWrite > 0;
  if (sawUsage) {
    recordUsage(inputs.chatId, {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      durationMs: inputs.durationMs,
      model: inputs.model,
      contextTokens: inputs.contextTokens || undefined,
      contextWindow: inputs.contextWindow,
      numApiCalls: inputs.apiCalls || undefined,
    });
  } else {
    // recordUsage clears the overlay itself; cover the zero-usage path.
    clearLiveTurn(inputs.chatId);
  }
}

/**
 * Record a flow violation (prose written without a delivery tool).
 * Always counts the dropped text; the outcome picks the second
 * counter. Centralised because openai-agents historically skipped the
 * cap-exhausted counter, making "how often do models ignore the
 * reminder" unanswerable for that backend.
 */
export function recordFlowViolation(
  outcome: "retried" | "cap_exhausted",
): void {
  incrementCounter("scratchpad.trailing_text_dropped");
  incrementCounter(
    outcome === "retried"
      ? "scratchpad.flow_violation_retried"
      : "scratchpad.flow_violation_cap_exhausted",
  );
}
