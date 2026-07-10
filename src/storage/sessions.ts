/**
 * Session manager — maps chat IDs to backend session IDs plus per-chat
 * usage accounting. The backend handles actual conversation storage
 * (JSONL); we track the mapping and the counters so conversations and
 * stats persist across messages.
 *
 * Backed by SQLite (see repositories/sessions-repo.ts for the
 * statements; this module holds the domain API — no SQL here) with an
 * in-memory write-through cache: getSession() returns a live
 * SessionState reference (the historical contract — in-module mutators
 * and tests mutate it in place), and every mutator commits the chat's
 * whole row immediately. Compared to the JsonStore this replaces,
 * there is no dirty flag and no 10s autosave timer — SQLite commits
 * per write.
 *
 * The legacy ~/.talon/data/sessions.json (JsonStore envelope or bare
 * pre-envelope shape) is imported once on first load, then renamed to
 * sessions.json.imported.
 */

import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { files } from "../util/paths.js";
import { importLegacyJson } from "./legacy-import.js";
import * as repo from "./repositories/sessions-repo.js";

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

// In-memory cache over the sessions table. Reads serve live references
// from here; writes go through persist() so each mutation commits.
const cache = new Map<string, SessionState>();

// ── Live-turn overlay ───────────────────────────────────────────────────────
//
// Mid-turn usage snapshot for the chat's IN-PROGRESS turn. Backends push
// updates here as their stream produces usage signals (per-API-call usage
// events, rollout polls, SSE summaries), so /status reflects reality while
// a long agentic turn is still running instead of showing the previous
// turn's numbers. Never persisted — recordUsage() commits the final turn
// totals and clears the overlay; clearLiveTurn() in the backends' finally
// blocks covers error/abort exits.
//
// All token fields are ABSOLUTE this-turn-so-far values (not deltas):
// each update replaces the fields it carries, and getSessionInfo() adds
// them on top of the persisted cumulative totals at read time.

export type LiveTurnUsage = {
  /** Effective input tokens consumed so far this turn. */
  inputTokens: number;
  /** Output tokens generated so far this turn. */
  outputTokens: number;
  /** Cache-read tokens so far this turn. */
  cacheRead: number;
  /** Cache-write tokens so far this turn. */
  cacheWrite: number;
  /** Latest known context fill (last API call's prompt size). */
  contextTokens: number;
  /** Model context window, if the stream reported it. */
  contextWindow: number;
  /** API round-trips observed so far this turn. */
  numApiCalls: number;
  /** When the turn started (first update). */
  startedAt: number;
  /** Last update timestamp. */
  updatedAt: number;
};

const liveTurns = new Map<string, LiveTurnUsage>();

/**
 * Merge a partial mid-turn usage snapshot into the chat's live overlay.
 * Fields not provided keep their previous value; numeric fields are
 * absolute this-turn-so-far values, clamped to ≥ 0.
 */
export function updateLiveTurn(
  chatId: string,
  partial: Partial<Omit<LiveTurnUsage, "startedAt" | "updatedAt">>,
): void {
  const now = Date.now();
  const prev = liveTurns.get(chatId);
  const next: LiveTurnUsage = prev ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextTokens: 0,
    contextWindow: 0,
    numApiCalls: 0,
    startedAt: now,
    updatedAt: now,
  };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheRead",
    "cacheWrite",
    "contextTokens",
    "contextWindow",
    "numApiCalls",
  ] as const) {
    const v = partial[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      next[key] = Math.max(0, v);
    }
  }
  next.updatedAt = now;
  liveTurns.set(chatId, next);
}

/** Drop the chat's live-turn overlay (turn finished, failed, or aborted). */
export function clearLiveTurn(chatId: string): void {
  liveTurns.delete(chatId);
}

/** Read the chat's live-turn overlay, if a turn is in progress. */
export function getLiveTurn(chatId: string): LiveTurnUsage | undefined {
  return liveTurns.get(chatId);
}

/**
 * Project the persisted cumulative usage through the live overlay: token
 * totals gain the in-progress turn's so-far counts; context fill, window
 * and API-call count show the freshest known values. Returns the stored
 * usage object untouched when no turn is live.
 */
function withLiveTurn(chatId: string, usage: SessionUsage): SessionUsage {
  const live = liveTurns.get(chatId);
  if (!live) return usage;
  return {
    ...usage,
    totalInputTokens: usage.totalInputTokens + live.inputTokens,
    totalOutputTokens: usage.totalOutputTokens + live.outputTokens,
    totalCacheRead: usage.totalCacheRead + live.cacheRead,
    totalCacheWrite: usage.totalCacheWrite + live.cacheWrite,
    contextTokens: live.contextTokens || usage.contextTokens,
    contextWindow: live.contextWindow || usage.contextWindow,
    numApiCalls: live.numApiCalls || usage.numApiCalls,
  };
}

// ── Persistence lifecycle ───────────────────────────────────────────────────

/**
 * Run the one-time import of the legacy JSON store, then prime the
 * cache from SQLite. Idempotent; called once at boot.
 */
export function loadSessions(): void {
  cache.clear();
  try {
    importLegacySessions();
    for (const { chatId, session } of repo.all()) {
      cache.set(chatId, session);
    }
  } catch (err) {
    logError("sessions", "Session load failed", err);
  }
}

/**
 * Legacy shape: Record<chatId, SessionState>. Partially-shaped legacy
 * records are tolerated — normaliseSession() backfills missing fields
 * on read, exactly as it did against the JSON store.
 */
function importLegacySessions(): void {
  importLegacyJson({
    path: files.sessions,
    category: "sessions",
    what: "session(s)",
    ingest: (data) => {
      const entries: Array<{ chatId: string; session: SessionState }> = [];
      for (const [chatId, session] of Object.entries(
        (data ?? {}) as Record<string, SessionState>,
      )) {
        if (!session || typeof session !== "object" || Array.isArray(session))
          continue;
        entries.push({ chatId, session });
      }
      return repo.upsertMany(entries);
    },
  });
}

/** Commit one chat's row; storage failure must never break a turn. */
function persist(chatId: string, session: SessionState): void {
  try {
    repo.upsert(chatId, session);
  } catch (err) {
    logError("sessions", "Failed to persist sessions", err);
    recordError(
      `Session save failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ── Core operations ─────────────────────────────────────────────────────────

const emptyUsage = (): SessionUsage => ({
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

const emptyCounters = (): MetricsCounterSet => ({
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

const emptyLatency = (): MetricsLatencyAgg => ({
  count: 0,
  sumMs: 0,
  minMs: Infinity,
  maxMs: 0,
});

const emptyGrain = (): MetricsGrain => ({
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

function addLatency(agg: MetricsLatencyAgg, value: number): void {
  if (!Number.isFinite(value)) return;
  agg.count += 1;
  agg.sumMs += value;
  agg.minMs = Math.min(agg.minMs, value);
  agg.maxMs = Math.max(agg.maxMs, value);
}

function addCounters(
  target: MetricsCounterSet,
  delta: Partial<MetricsCounterSet>,
): void {
  for (const [key, value] of Object.entries(delta) as Array<
    [keyof MetricsCounterSet, number | undefined]
  >) {
    if (typeof value === "number" && Number.isFinite(value))
      target[key] += value;
  }
}

/** UTC day key (`YYYY-MM-DD`) used for daily metric buckets. */
export function todayUtc(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function metricBucket(metrics: SessionMetrics, day: string): MetricsGrain {
  metrics.buckets[day] ??= emptyGrain();
  const days = Object.keys(metrics.buckets).sort();
  while (days.length > 30) {
    const oldest = days.shift();
    if (oldest) delete metrics.buckets[oldest];
  }
  return metrics.buckets[day]!;
}

/**
 * Normalise a session state object in-place. Migrates fields that
 * pre-date later schema additions (response timing, context fill,
 * etc.) without rewriting the persisted record.
 */
function normaliseSession(session: SessionState): SessionState {
  if (!session.usage) session.usage = emptyUsage();
  // Metrics blobs are normalised once when rows are hydrated
  // (sessions-repo parseMetrics); here only backfill pre-metrics records.
  if (!session.metrics) session.metrics = emptyMetrics();
  if (!session.createdAt) session.createdAt = session.lastActive;
  if (session.usage.totalResponseMs === undefined)
    session.usage.totalResponseMs = 0;
  if (session.usage.lastResponseMs === undefined)
    session.usage.lastResponseMs = 0;
  if (
    session.usage.fastestResponseMs === undefined ||
    session.usage.fastestResponseMs === null ||
    session.usage.fastestResponseMs === 0
  )
    session.usage.fastestResponseMs = Infinity;
  if (session.usage.contextTokens === undefined)
    session.usage.contextTokens = 0;
  if (session.usage.contextWindow === undefined)
    session.usage.contextWindow = 0;
  if (session.usage.numApiCalls === undefined) session.usage.numApiCalls = 0;
  return session;
}

export function getSession(chatId: string): SessionState {
  let session = cache.get(chatId);
  if (!session) {
    const now = Date.now();
    session = {
      sessionId: undefined,
      turns: 0,
      lastActive: now,
      createdAt: now,
      usage: emptyUsage(),
      metrics: emptyMetrics(),
    };
    cache.set(chatId, session);
    persist(chatId, session);
  }
  return normaliseSession(session);
}

export type SessionMetricTurn = {
  backend: string;
  durationMs: number;
  toolCalls?: number;
  toolCallsByName?: Record<string, number>;
  apiCalls?: number;
  failed?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
};

function foldMetricTurn(grain: MetricsGrain, turn: SessionMetricTurn): void {
  addCounters(grain.counters, {
    queries: 1,
    turnsWithTools: turn.toolCalls && turn.toolCalls > 0 ? 1 : 0,
    apiCalls: turn.apiCalls ?? 0,
    failedTurns: turn.failed ? 1 : 0,
    inputTokens: turn.usage?.inputTokens ?? 0,
    outputTokens: turn.usage?.outputTokens ?? 0,
    cacheReadTokens: turn.usage?.cacheRead ?? 0,
    cacheWriteTokens: turn.usage?.cacheWrite ?? 0,
  });
  addLatency(grain.latency, turn.durationMs);
  if (turn.toolCalls !== undefined)
    addLatency(grain.toolCallsPerTurn, turn.toolCalls);
  if (turn.apiCalls !== undefined && turn.apiCalls > 0)
    addLatency(grain.apiCallsPerTurn, turn.apiCalls);
  if (turn.usage && turn.usage.inputTokens + turn.usage.cacheRead > 0) {
    addLatency(
      grain.cacheHitPercent,
      Math.round(
        (turn.usage.cacheRead /
          (turn.usage.inputTokens + turn.usage.cacheRead)) *
          100,
      ),
    );
  }
  for (const [name, count] of Object.entries(turn.toolCallsByName ?? {})) {
    if (Number.isFinite(count))
      grain.toolCallsByName[name] = (grain.toolCallsByName[name] ?? 0) + count;
  }
  const backend = (grain.backend[turn.backend] ??= {
    ...emptyCounters(),
    latency: emptyLatency(),
  });
  addCounters(backend, {
    queries: 1,
    apiCalls: turn.apiCalls ?? 0,
    failedTurns: turn.failed ? 1 : 0,
    inputTokens: turn.usage?.inputTokens ?? 0,
    outputTokens: turn.usage?.outputTokens ?? 0,
    cacheReadTokens: turn.usage?.cacheRead ?? 0,
    cacheWriteTokens: turn.usage?.cacheWrite ?? 0,
  });
  addLatency(backend.latency, turn.durationMs);
}

export function recordSessionMetrics(
  chatId: string,
  turn: SessionMetricTurn,
  day = todayUtc(),
): void {
  const session = getSession(chatId);
  foldMetricTurn(session.metrics.lifetime, turn);
  foldMetricTurn(metricBucket(session.metrics, day), turn);
  persist(chatId, session);
}

export function recordSessionMetricEvent(
  chatId: string,
  event: Partial<MetricsCounterSet> & {
    toolName?: string;
    backend?: string;
  },
  day = todayUtc(),
): void {
  const session = getSession(chatId);
  for (const grain of [
    session.metrics.lifetime,
    metricBucket(session.metrics, day),
  ]) {
    addCounters(grain.counters, event);
    if (event.toolName && event.toolCalls) {
      grain.toolCallsByName[event.toolName] =
        (grain.toolCallsByName[event.toolName] ?? 0) + event.toolCalls;
    }
    if (event.backend) {
      const backend = (grain.backend[event.backend] ??= {
        ...emptyCounters(),
        latency: emptyLatency(),
      });
      addCounters(backend, event);
    }
  }
  persist(chatId, session);
}

export function resetAllSessionMetrics(): void {
  for (const [chatId, session] of cache.entries()) {
    session.metrics = emptyMetrics();
    persist(chatId, session);
  }
}

export function setSessionId(chatId: string, sessionId: string): void {
  const session = getSession(chatId);
  session.sessionId = sessionId;
  persist(chatId, session);
}

export function incrementTurns(chatId: string): void {
  const session = getSession(chatId);
  session.turns += 1;
  session.lastActive = Date.now();
  persist(chatId, session);
}

export function recordUsage(
  chatId: string,
  turn: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    durationMs?: number;
    model?: string;
    /** Actual context fill from the last API call (last iteration's prompt tokens). */
    contextTokens?: number;
    /** Model context window size from SDK modelUsage. */
    contextWindow?: number;
    /** Number of agentic turns / API round-trips in this turn. */
    numApiCalls?: number;
    costUsd?: number;
  },
): void {
  // The turn is finalizing — the overlay's job is done. Clear it BEFORE
  // mutating the totals so a concurrent /status never sees the turn
  // counted twice (overlay + committed totals).
  clearLiveTurn(chatId);
  const session = getSession(chatId);
  session.usage.totalInputTokens += turn.inputTokens;
  session.usage.totalOutputTokens += turn.outputTokens;
  session.usage.totalCacheRead += turn.cacheRead;
  session.usage.totalCacheWrite += turn.cacheWrite;
  session.usage.lastPromptTokens =
    turn.inputTokens + turn.cacheRead + turn.cacheWrite;
  session.usage.contextTokens = turn.contextTokens ?? 0;
  if (
    turn.contextWindow !== undefined &&
    Number.isFinite(turn.contextWindow) &&
    turn.contextWindow > 0
  ) {
    session.usage.contextWindow = turn.contextWindow;
  }
  session.usage.numApiCalls = turn.numApiCalls ?? 0;
  if (typeof turn.costUsd === "number" && Number.isFinite(turn.costUsd)) {
    session.usage.estimatedCostUsd += turn.costUsd;
  }
  if (turn.model) session.lastModel = turn.model;
  if (turn.durationMs && turn.durationMs > 0) {
    session.usage.totalResponseMs =
      (session.usage.totalResponseMs || 0) + turn.durationMs;
    session.usage.lastResponseMs = turn.durationMs;
    const current = session.usage.fastestResponseMs;
    if (turn.durationMs < current) {
      session.usage.fastestResponseMs = turn.durationMs;
    }
  }
  persist(chatId, session);
}

export function setSessionName(chatId: string, name: string): void {
  const session = getSession(chatId);
  session.sessionName = name;
  persist(chatId, session);
}

export function setLastBotMessageId(chatId: string, messageId: number): void {
  const session = getSession(chatId);
  session.lastBotMessageId = messageId;
  persist(chatId, session);
}

export function getLastBotMessageId(chatId: string): number | undefined {
  return cache.get(chatId)?.lastBotMessageId;
}

function removeSessionRow(chatId: string): void {
  cache.delete(chatId);
  clearLiveTurn(chatId);
  try {
    repo.remove(chatId);
  } catch (err) {
    logError("sessions", "Failed to delete session row", err);
    recordError(
      `Session delete failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Reset the chat's conversation state (backend session id, turns, usage)
 * while carrying its metrics forward. Resets fire on /new, model switches
 * and error recovery — none of which should erase the chat's accounting
 * history (that's what makes per-session metrics survive anything short
 * of deleting the chat). Use deleteSession() to drop the chat entirely.
 */
export function resetSession(chatId: string): void {
  const session = cache.get(chatId);
  const turns = session?.turns ?? 0;
  const name = session?.sessionName;
  const metrics = session?.metrics;
  removeSessionRow(chatId);
  const hasHistory =
    metrics &&
    (metrics.lifetime.counters.queries > 0 ||
      metrics.lifetime.counters.toolCalls > 0);
  if (hasHistory) {
    const now = Date.now();
    const fresh: SessionState = {
      sessionId: undefined,
      turns: 0,
      lastActive: now,
      createdAt: now,
      usage: emptyUsage(),
      metrics,
    };
    cache.set(chatId, fresh);
    persist(chatId, fresh);
  }
  log(
    "sessions",
    `[${chatId}] Reset${name ? ` "${name}"` : ""} (${turns} turns)`,
  );
}

/** Drop the chat entirely — row, cache, live overlay and metrics. */
export function deleteSession(chatId: string): void {
  const session = cache.get(chatId);
  const turns = session?.turns ?? 0;
  const name = session?.sessionName;
  removeSessionRow(chatId);
  log(
    "sessions",
    `[${chatId}] Deleted${name ? ` "${name}"` : ""} (${turns} turns)`,
  );
}

export type SessionInfo = {
  sessionId: string | undefined;
  turns: number;
  lastActive: number;
  createdAt: number;
  usage: SessionUsage;
  metrics: SessionMetrics;
  sessionName?: string;
  lastModel?: string;
  /** True when a turn is currently streaming and `usage` includes its live so-far counts. */
  turnInProgress?: boolean;
};

export function getSessionInfo(chatId: string): SessionInfo {
  const session = cache.get(chatId);
  return {
    sessionId: session?.sessionId,
    turns: session?.turns ?? 0,
    lastActive: session?.lastActive ?? 0,
    createdAt: session?.createdAt ?? 0,
    usage: withLiveTurn(chatId, session?.usage ?? emptyUsage()),
    metrics: session?.metrics ?? emptyMetrics(),
    sessionName: session?.sessionName,
    lastModel: session?.lastModel,
    turnInProgress: liveTurns.has(chatId),
  };
}

export function getActiveSessionCount(): number {
  return cache.size;
}

/** Get all chat IDs with active sessions and their info. */
export function getAllSessions(): Array<{ chatId: string; info: SessionInfo }> {
  return [...cache.entries()].map(([chatId, session]) => ({
    chatId,
    info: {
      sessionId: session.sessionId,
      turns: session.turns,
      lastActive: session.lastActive,
      createdAt: session.createdAt,
      usage: withLiveTurn(chatId, session.usage ?? emptyUsage()),
      metrics: session.metrics ?? emptyMetrics(),
      sessionName: session.sessionName,
      lastModel: session.lastModel,
      turnInProgress: liveTurns.has(chatId),
    },
  }));
}
