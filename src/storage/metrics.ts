// Session-backed metrics aggregation. Writes for chat turns live on
// storage/sessions.ts; this module keeps the public read shape used by
// /metrics and a small compatibility sink for non-chat legacy counters.

import {
  getAllSessions,
  resetAllSessionMetrics,
  todayUtc,
  type MetricsGrain,
  type MetricsLatencyAgg,
} from "./sessions.js";
import { emptyPhases, TURN_PHASES, type TurnPhase } from "./session-record.js";

/** Snapshot key for each turn phase — same `_ms` suffix the panels key on. */
const PHASE_HISTOGRAM: Record<TurnPhase, string> = {
  queueWait: "turn.queue_wait_ms",
  warpResolve: "turn.warp_resolve_ms",
  firstToken: "turn.first_token_ms",
  stream: "turn.stream_ms",
  delivery: "turn.delivery_ms",
};

const legacyCounters = new Map<string, number>();

/**
 * Process-lifetime distributions for values that are not chat-turn
 * latencies and so have nowhere to live on a session record — currently
 * `prompt.memory_chars`, the size of the injected memory block, which is
 * what the `TALON_MEMORY_STORE` before/after comparison reads.
 */
const processHistograms = new Map<string, MetricsLatencyAgg>();

/**
 * A chat's last cross-turn cache verdict — did the turn's FIRST request
 * read the previous turn's prefix (`hit`), pay to re-write it (`miss`), or
 * was nothing cacheable at all (`none`)? Mirrors `CrossTurnVerdict` in
 * backend/shared/cache-telemetry.ts, which owns the classification; the
 * union is restated here because `/status` renders it and frontends may
 * not import backend/ (.dependency-cruiser.cjs: frontend-not-to-backend).
 */
export type CacheVerdict = "hit" | "miss" | "none";

/**
 * Per-chat last verdict. Process-local and deliberately unpersisted: it
 * describes the live prefix, which dies with the process anyway, and
 * `/status` is the only reader. Bounded like the per-chat maps in
 * cache-telemetry.ts, insertion-ordered eviction.
 */
const MAX_TRACKED_CHATS = 256;
const lastCacheVerdicts = new Map<string, CacheVerdict>();

/** Record the chat's newest cross-turn cache verdict. */
export function noteCacheVerdict(chatId: string, verdict: CacheVerdict): void {
  if (
    lastCacheVerdicts.size >= MAX_TRACKED_CHATS &&
    !lastCacheVerdicts.has(chatId)
  ) {
    const oldest = lastCacheVerdicts.keys().next().value;
    if (oldest !== undefined) lastCacheVerdicts.delete(oldest);
  }
  lastCacheVerdicts.set(chatId, verdict);
}

/** The chat's last cross-turn verdict, or undefined if none was recorded. */
export function getCacheVerdict(chatId: string): CacheVerdict | undefined {
  return lastCacheVerdicts.get(chatId);
}

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

/**
 * Record one observation of a non-turn distribution. Lifetime-scoped and
 * in-process, like the legacy counters: it surfaces in `getMetrics()`
 * (count / avg / min / max), not in the daily rollup.
 */
export function recordHistogram(name: string, value: number): void {
  if (!Number.isFinite(value)) return;
  const agg = processHistograms.get(name) ?? emptyAgg();
  mergeAgg(agg, { count: 1, sumMs: value, minMs: value, maxMs: value });
  processHistograms.set(name, agg);
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
  const phases = emptyPhases();

  for (const grain of grains) {
    for (const phase of TURN_PHASES) {
      mergeAgg(phases[phase], grain.phases[phase]);
    }
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
  for (const phase of TURN_PHASES) {
    if (phases[phase].count)
      histograms[PHASE_HISTOGRAM[phase]] = snapshotAgg(phases[phase]);
  }

  return { counters, histograms };
}

/** Lifetime fleet snapshot: all sessions' cumulative metrics plus the
 * in-process legacy counters. */
export function getMetrics(): MetricsSnapshot {
  const counters: Record<string, number> = {};
  for (const [key, value] of legacyCounters) addCounter(counters, key, value);
  const snapshot = buildSnapshot(
    getAllSessions().map(({ info }) => info.metrics.lifetime),
    counters,
  );
  for (const [name, agg] of processHistograms) {
    if (agg.count) snapshot.histograms[name] = snapshotAgg(agg);
  }
  return snapshot;
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
  processHistograms.clear();
  lastCacheVerdicts.clear();
  resetAllSessionMetrics();
}
