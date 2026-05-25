import { existsSync, mkdirSync } from "node:fs";
import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { dirs, files } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";
import { JsonStore } from "../core/agent-runtime/store.js";

/**
 * Session manager — maps Telegram chat IDs to Claude SDK session IDs.
 * The SDK handles actual conversation storage (JSONL); we just track
 * the mapping so conversations persist across messages.
 *
 * Persisted via the unified `JsonStore<T>` envelope at
 * `~/.talon/data/sessions.json`. A migrate hook accepts the
 * pre-envelope bare-object shape so existing on-disk state loads
 * unchanged.
 */

type SessionUsage = {
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

type SessionState = {
  /** Claude SDK server-side session ID. */
  sessionId: string | undefined;
  /** Turn count. */
  turns: number;
  /** Last activity timestamp. */
  lastActive: number;
  /** Created timestamp. */
  createdAt: number;
  /** Cumulative usage stats. */
  usage: SessionUsage;
  /** ID of the last message sent by the bot in this chat. */
  lastBotMessageId?: number;
  /** Descriptive session name derived from first message. */
  sessionName?: string;
  /** Model used for this session's cost tracking. */
  lastModel?: string;
};

type SessionStore = Record<string, SessionState>;

const STORE_FILE = files.sessions;
const SCHEMA_VERSION = 1 as const;

const store = new JsonStore<SessionStore>({
  path: STORE_FILE,
  defaultValue: {},
  schemaVersion: SCHEMA_VERSION,
  migrate: (raw, fromVersion) => {
    if (fromVersion !== 0) return null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { value: {}, schemaVersion: SCHEMA_VERSION };
    }
    return {
      value: raw as SessionStore,
      schemaVersion: SCHEMA_VERSION,
    };
  },
});

function ensureDir(): void {
  if (!existsSync(dirs.data)) mkdirSync(dirs.data, { recursive: true });
}

export function loadSessions(): void {
  store.reset();
  try {
    store.loadSync();
  } catch (err) {
    logError("sessions", "Session load failed", err);
  }
}

function saveSessions(): void {
  if (!store.isDirty()) return;
  try {
    ensureDir();
    store.saveSync();
  } catch (err) {
    logError("sessions", "Failed to persist sessions", err);
    recordError(
      `Session save failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

const autoSaveTimer = setInterval(saveSessions, 10_000);

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

/**
 * Normalise a session state object in-place. Migrates fields that
 * pre-date later schema additions (response timing, context fill,
 * etc.) without rewriting the on-disk record.
 */
function normaliseSession(session: SessionState): SessionState {
  if (!session.usage) session.usage = emptyUsage();
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
  const data = store.get();
  let session = data[chatId];
  if (!session) {
    const now = Date.now();
    session = {
      sessionId: undefined,
      turns: 0,
      lastActive: now,
      createdAt: now,
      usage: emptyUsage(),
    };
    store.update((s) => {
      s[chatId] = session;
    });
  }
  return normaliseSession(session);
}

export function setSessionId(chatId: string, sessionId: string): void {
  const session = getSession(chatId);
  session.sessionId = sessionId;
  store.update(() => undefined);
}

export function incrementTurns(chatId: string): void {
  const session = getSession(chatId);
  session.turns += 1;
  session.lastActive = Date.now();
  store.update(() => undefined);
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
  store.update(() => undefined);
}

export function setSessionName(chatId: string, name: string): void {
  const session = getSession(chatId);
  session.sessionName = name;
  store.update(() => undefined);
}

export function setLastBotMessageId(chatId: string, messageId: number): void {
  const session = getSession(chatId);
  session.lastBotMessageId = messageId;
  store.update(() => undefined);
}

export function getLastBotMessageId(chatId: string): number | undefined {
  return store.get()[chatId]?.lastBotMessageId;
}

export function resetSession(chatId: string): void {
  const session = store.get()[chatId];
  const turns = session?.turns ?? 0;
  const name = session?.sessionName;
  store.update((s) => {
    delete s[chatId];
  });
  saveSessions();
  log(
    "sessions",
    `[${chatId}] Reset${name ? ` "${name}"` : ""} (${turns} turns)`,
  );
}

export type SessionInfo = {
  sessionId: string | undefined;
  turns: number;
  lastActive: number;
  createdAt: number;
  usage: SessionUsage;
  sessionName?: string;
  lastModel?: string;
};

export function getSessionInfo(chatId: string): SessionInfo {
  const session = store.get()[chatId];
  return {
    sessionId: session?.sessionId,
    turns: session?.turns ?? 0,
    lastActive: session?.lastActive ?? 0,
    createdAt: session?.createdAt ?? 0,
    usage: session?.usage ?? emptyUsage(),
    sessionName: session?.sessionName,
    lastModel: session?.lastModel,
  };
}

export function getActiveSessionCount(): number {
  return Object.keys(store.get()).length;
}

/** Get all chat IDs with active sessions and their info. */
export function getAllSessions(): Array<{ chatId: string; info: SessionInfo }> {
  return Object.entries(store.get()).map(([chatId, session]) => ({
    chatId,
    info: {
      sessionId: session.sessionId,
      turns: session.turns,
      lastActive: session.lastActive,
      createdAt: session.createdAt,
      usage: session.usage ?? emptyUsage(),
      sessionName: session.sessionName,
      lastModel: session.lastModel,
    },
  }));
}

registerCleanup(saveSessions);

/** Force-save sessions to disk and stop the auto-save timer. */
export function flushSessions(): void {
  clearInterval(autoSaveTimer);
  store.update(() => undefined);
  saveSessions();
}
