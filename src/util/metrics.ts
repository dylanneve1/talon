// Session-backed metrics aggregation. Writes for chat turns live on
// storage/sessions.ts; this module keeps the public read shape used by
// /metrics and a small compatibility sink for non-chat legacy counters.

import {
  getAllSessions,
  resetAllSessionMetrics,
  todayUtc,
  type MetricsGrain,
  type MetricsLatencyAgg,
} from "../storage/sessions.js";

const legacyCounters = new Map<string, number>();

export type MetricsSnapshot = {
  counters: Record<string, number>;
  histograms: Record<
    string,
    { count: number; avg: number; min: number; max: number }
  >;
};

export function incrementCounter(name: string, amount = 1): void {
  legacyCounters.set(name, (legacyCounters.get(name) ?? 0) + amount);
}

export function recordHistogram(_name: string, _value: number): void {
  // The old global histogram ring is intentionally gone. Chat-turn
  // histograms are now latency aggregates on SessionMetrics.
}

function addCounter(
  counters: Record<string, number>,
  name: string,
  amount: number | undefined,
): void {
  if (typeof amount === "number" && Number.isFinite(amount) && amount !== 0) {
    counters[name] = (counters[name] ?? 0) + amount;
  }
}

function mergeAgg(target: MetricsLatencyAgg, source: MetricsLatencyAgg): void {
  if (!source.count) return;
  target.count += source.count;
  target.sumMs += source.sumMs;
  target.minMs = Math.min(target.minMs, source.minMs);
  target.maxMs = Math.max(target.maxMs, source.maxMs);
}

function emptyAgg(): MetricsLatencyAgg {
  return { count: 0, sumMs: 0, minMs: Infinity, maxMs: 0 };
}

function snapshotAgg(agg: MetricsLatencyAgg) {
  return {
    count: agg.count,
    avg: Math.round(agg.sumMs / agg.count),
    min: agg.minMs,
    max: agg.maxMs,
  };
}

function buildSnapshot(
  grains: MetricsGrain[],
  counters: Record<string, number>,
): MetricsSnapshot {
  const responseLatency = emptyAgg();
  const toolCallsPerTurn = emptyAgg();
  const apiCallsPerTurn = emptyAgg();
  const cacheHitPercent = emptyAgg();
  const backendLatency = new Map<string, MetricsLatencyAgg>();

  for (const grain of grains) {
    const c = grain.counters;
    addCounter(counters, "queries_total", c.queries);
    addCounter(counters, "turns_with_tools_total", c.turnsWithTools);
    addCounter(counters, "api_calls_total", c.apiCalls);
    addCounter(counters, "tokens.input_total", c.inputTokens);
    addCounter(counters, "tokens.output_total", c.outputTokens);
    addCounter(counters, "tokens.cache_read_total", c.cacheReadTokens);
    addCounter(counters, "tokens.cache_write_total", c.cacheWriteTokens);
    addCounter(
      counters,
      "scratchpad.trailing_text_dropped",
      c.trailingTextDropped,
    );
    addCounter(
      counters,
      "scratchpad.flow_violation_retried",
      c.flowViolationRetries,
    );
    addCounter(
      counters,
      "scratchpad.flow_violation_cap_exhausted",
      c.flowViolationCapExhausted,
    );
    for (const [name, count] of Object.entries(grain.toolCallsByName)) {
      addCounter(counters, `tool_calls.${name}`, count);
    }
    for (const [backend, bc] of Object.entries(grain.backend)) {
      addCounter(counters, `backend.${backend}.queries`, bc.queries);
      addCounter(counters, `backend.${backend}.tool_calls`, bc.toolCalls);
      addCounter(counters, `backend.${backend}.turn_failed`, bc.failedTurns);
      addCounter(counters, `backend.${backend}.tokens.input`, bc.inputTokens);
      addCounter(counters, `backend.${backend}.tokens.output`, bc.outputTokens);
      addCounter(
        counters,
        `backend.${backend}.tokens.cache_read`,
        bc.cacheReadTokens,
      );
      addCounter(
        counters,
        `backend.${backend}.tokens.cache_write`,
        bc.cacheWriteTokens,
      );
      const agg = backendLatency.get(backend) ?? emptyAgg();
      mergeAgg(agg, bc.latency);
      backendLatency.set(backend, agg);
    }
    mergeAgg(responseLatency, grain.latency);
    mergeAgg(toolCallsPerTurn, grain.toolCallsPerTurn);
    mergeAgg(apiCallsPerTurn, grain.apiCallsPerTurn);
    mergeAgg(cacheHitPercent, grain.cacheHitPercent);
  }

  const histograms: MetricsSnapshot["histograms"] = {};
  if (responseLatency.count)
    histograms.response_latency_ms = snapshotAgg(responseLatency);
  if (toolCallsPerTurn.count)
    histograms.tool_calls_per_turn = snapshotAgg(toolCallsPerTurn);
  if (apiCallsPerTurn.count)
    histograms.api_calls_per_turn = snapshotAgg(apiCallsPerTurn);
  if (cacheHitPercent.count)
    histograms.cache_hit_percent = snapshotAgg(cacheHitPercent);
  for (const [backend, agg] of backendLatency) {
    if (agg.count)
      histograms[`backend.${backend}.response_latency_ms`] = snapshotAgg(agg);
  }

  return { counters, histograms };
}

/** Lifetime fleet snapshot: all sessions' cumulative metrics plus the
 * in-process legacy counters. */
export function getMetrics(): MetricsSnapshot {
  const counters: Record<string, number> = {};
  for (const [key, value] of legacyCounters) addCounter(counters, key, value);
  return buildSnapshot(
    getAllSessions().map(({ info }) => info.metrics.lifetime),
    counters,
  );
}

/** Today's (UTC) fleet snapshot, aggregated from the sessions' daily
 * rollup buckets. Legacy counters are process-lifetime, not daily, so
 * they are excluded here. */
export function getTodayMetrics(): MetricsSnapshot {
  const day = todayUtc();
  return buildSnapshot(
    getAllSessions().flatMap(({ info }) => info.metrics.buckets[day] ?? []),
    {},
  );
}

export function resetMetrics(): void {
  legacyCounters.clear();
  resetAllSessionMetrics();
}
