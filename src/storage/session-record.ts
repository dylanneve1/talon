/**
 * Session record shapes + their constructors and normalisers — the
 * vocabulary both the public store (storage/sessions.ts) and the
 * repository (repositories/sessions-repo.ts) speak, extracted so the
 * repo never has to import the store (which imports the repo).
 *
 * Mutation logic (fold/add/bucket) stays in the store; this module owns
 * only "what a well-formed record looks like" and "how a raw JSON blob
 * becomes one".
 */

export type SessionUsage = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  /** Last turn's total prompt tokens (cumulative across all API calls in the turn, including tool-use loops). */
  lastPromptTokens: number;
  /** Actual context window fill from the last API call (last iteration's prompt tokens). */
  contextTokens: number;
  /** Model's context window size in tokens (from SDK modelUsage). */
  contextWindow: number;
  /** Number of API round-trips in the last turn (tool-use steps). */
  numApiCalls: number;
  /** Estimated cost in USD. */
  estimatedCostUsd: number;
  /** Total response time in ms (for averaging). */
  totalResponseMs: number;
  /** Last response time in ms. */
  lastResponseMs: number;
  /** Fastest response time in ms. */
  fastestResponseMs: number;
};

export type MetricsCounterSet = {
  queries: number;
  toolCalls: number;
  turnsWithTools: number;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  failedTurns: number;
  flowViolationRetries: number;
  flowViolationCapExhausted: number;
  trailingTextDropped: number;
};

export type MetricsLatencyAgg = {
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
};

export type MetricsGrain = {
  counters: MetricsCounterSet;
  latency: MetricsLatencyAgg;
  toolCallsByName: Record<string, number>;
  backend: Record<string, MetricsCounterSet & { latency: MetricsLatencyAgg }>;
  cacheHitPercent: MetricsLatencyAgg;
  toolCallsPerTurn: MetricsLatencyAgg;
  apiCallsPerTurn: MetricsLatencyAgg;
};

export type SessionMetrics = {
  lifetime: MetricsGrain;
  buckets: Record<string, MetricsGrain>;
};

export type SessionState = {
  /** Backend server-side session ID. */
  sessionId: string | undefined;
  /** Turn count. */
  turns: number;
  /** Last activity timestamp. */
  lastActive: number;
  /** Created timestamp. */
  createdAt: number;
  /** Cumulative usage stats. */
  usage: SessionUsage;
  /** Persistent per-session metrics, bucketed by UTC day. */
  metrics: SessionMetrics;
  /** ID of the last message sent by the bot in this chat. */
  lastBotMessageId?: number;
  /** Descriptive session name derived from first message. */
  sessionName?: string;
  /** Model used for this session's cost tracking. */
  lastModel?: string;
};

export const emptyUsage = (): SessionUsage => ({
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  lastPromptTokens: 0,
  contextTokens: 0,
  contextWindow: 0,
  numApiCalls: 0,
  estimatedCostUsd: 0,
  totalResponseMs: 0,
  lastResponseMs: 0,
  fastestResponseMs: Infinity,
});

export const emptyCounters = (): MetricsCounterSet => ({
  queries: 0,
  toolCalls: 0,
  turnsWithTools: 0,
  apiCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  failedTurns: 0,
  flowViolationRetries: 0,
  flowViolationCapExhausted: 0,
  trailingTextDropped: 0,
});

export const emptyLatency = (): MetricsLatencyAgg => ({
  count: 0,
  sumMs: 0,
  minMs: Infinity,
  maxMs: 0,
});

export const emptyGrain = (): MetricsGrain => ({
  counters: emptyCounters(),
  latency: emptyLatency(),
  toolCallsByName: {},
  backend: {},
  cacheHitPercent: emptyLatency(),
  toolCallsPerTurn: emptyLatency(),
  apiCallsPerTurn: emptyLatency(),
});

export const emptyMetrics = (): SessionMetrics => ({
  lifetime: emptyGrain(),
  buckets: {},
});

function normaliseLatency(raw: unknown): MetricsLatencyAgg {
  const r = raw as Partial<MetricsLatencyAgg> | undefined;
  const count =
    typeof r?.count === "number" && Number.isFinite(r.count) ? r.count : 0;
  return {
    count,
    sumMs:
      typeof r?.sumMs === "number" && Number.isFinite(r.sumMs) ? r.sumMs : 0,
    minMs:
      typeof r?.minMs === "number" && Number.isFinite(r.minMs)
        ? r.minMs
        : count > 0
          ? 0
          : Infinity,
    maxMs:
      typeof r?.maxMs === "number" && Number.isFinite(r.maxMs) ? r.maxMs : 0,
  };
}

function normaliseCounters(raw: unknown): MetricsCounterSet {
  const base = emptyCounters();
  const r = raw as Partial<MetricsCounterSet> | undefined;
  for (const key of Object.keys(base) as Array<keyof MetricsCounterSet>) {
    const value = r?.[key];
    if (typeof value === "number" && Number.isFinite(value)) base[key] = value;
  }
  return base;
}

function normaliseGrain(raw: unknown): MetricsGrain {
  const r = raw as Partial<MetricsGrain> | undefined;
  const grain = emptyGrain();
  grain.counters = normaliseCounters(r?.counters);
  grain.latency = normaliseLatency(r?.latency);
  grain.cacheHitPercent = normaliseLatency(r?.cacheHitPercent);
  grain.toolCallsPerTurn = normaliseLatency(r?.toolCallsPerTurn);
  grain.apiCallsPerTurn = normaliseLatency(r?.apiCallsPerTurn);
  if (r?.toolCallsByName && typeof r.toolCallsByName === "object") {
    for (const [key, value] of Object.entries(r.toolCallsByName)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        grain.toolCallsByName[key] = value;
      }
    }
  }
  if (r?.backend && typeof r.backend === "object") {
    for (const [key, value] of Object.entries(r.backend)) {
      grain.backend[key] = {
        ...normaliseCounters(value),
        latency: normaliseLatency((value as { latency?: unknown }).latency),
      };
    }
  }
  return grain;
}

/**
 * Coerce an untrusted/persisted metrics blob into a well-formed
 * SessionMetrics: missing fields backfilled, non-finite numbers dropped,
 * JSON's `minMs: null` (Infinity doesn't survive JSON.stringify) restored
 * to the domain sentinel. Runs once at the load boundary (sessions-repo);
 * in-memory metrics stay well-formed by construction after that.
 */
export function normaliseMetrics(metrics: unknown): SessionMetrics {
  const raw = metrics as Partial<SessionMetrics> | undefined;
  const result: SessionMetrics = {
    lifetime: normaliseGrain(raw?.lifetime),
    buckets: {},
  };
  if (raw?.buckets && typeof raw.buckets === "object") {
    for (const [day, grain] of Object.entries(raw.buckets)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day))
        result.buckets[day] = normaliseGrain(grain);
    }
  }
  return result;
}
