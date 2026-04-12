import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { dirs, files } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";

/**
 * Session manager — maps Telegram chat IDs to Claude SDK session IDs.
 * The SDK handles actual conversation storage (JSONL); we just track
 * the mapping so conversations persist across messages.
 *
 * Sessions are persisted to disk so they survive restarts.
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
let store: SessionStore = {};
let dirty = false;

function ensureDir(): void {
  if (!existsSync(dirs.data)) mkdirSync(dirs.data, { recursive: true });
}

export function loadSessions(): void {
  try {
    if (existsSync(STORE_FILE)) {
      store = JSON.parse(readFileSync(STORE_FILE, "utf-8"));
    }
  } catch {
    // Primary file corrupt — try backup
    const bakFile = STORE_FILE + ".bak";
    try {
      if (existsSync(bakFile)) {
        store = JSON.parse(readFileSync(bakFile, "utf-8"));
        logError("sessions", "Loaded from backup (primary was corrupt)");
        return;
      }
    } catch {
      /* backup also corrupt */
    }
    logError(
      "sessions",
      "Session data corrupt and no valid backup — starting fresh",
    );
    store = {};
  }
}

function saveSessions(): void {
  if (!dirty) return;
  try {
    ensureDir();
    const data = JSON.stringify(store, null, 2) + "\n";
    // Write backup of current file before overwriting
    if (existsSync(STORE_FILE)) {
      try {
        writeFileAtomic.sync(STORE_FILE + ".bak", readFileSync(STORE_FILE));
      } catch {
        /* best effort */
      }
    }
    // Atomic write: writes to temp file then renames — prevents corruption on crash
    writeFileAtomic.sync(STORE_FILE, data);
    dirty = false;
  } catch (err) {
    logError("sessions", "Failed to persist sessions", err);
    recordError(
      `Session save failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// Auto-save every 10 seconds if dirty
const autoSaveTimer = setInterval(saveSessions, 10_000);

// Periodic stale session pruning (every hour)

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

export function getSession(chatId: string): SessionState {
  let session = store[chatId];
  if (!session) {
    const now = Date.now();
    session = {
      sessionId: undefined,
      turns: 0,
      lastActive: now,
      createdAt: now,
      usage: emptyUsage(),
    };
    store[chatId] = session;
  }
  // Migrate old sessions without usage or missing fields
  if (!session.usage) session.usage = emptyUsage();
  if (!session.createdAt) session.createdAt = session.lastActive;
  if (session.usage.totalResponseMs === undefined)
    session.usage.totalResponseMs = 0;
  if (session.usage.lastResponseMs === undefined)
    session.usage.lastResponseMs = 0;
  if (
    session.usage.fastestResponseMs === undefined ||
    session.usage.fastestResponseMs === 0
  )
    session.usage.fastestResponseMs = Infinity;
  return session;
}

export function setSessionId(chatId: string, sessionId: string): void {
  const session = getSession(chatId);
  session.sessionId = sessionId;
  dirty = true;
}

export function incrementTurns(chatId: string): void {
  const session = getSession(chatId);
  session.turns += 1;
  session.lastActive = Date.now();
  dirty = true;
}

/** Model-specific pricing ($ per million tokens). */
const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};

function getPricing(model?: string): (typeof MODEL_PRICING)["sonnet"] {
  if (!model) return MODEL_PRICING.sonnet;
  const lower = model.toLowerCase();
  if (lower.includes("haiku")) return MODEL_PRICING.haiku;
  if (lower.includes("opus")) return MODEL_PRICING.opus;
  return MODEL_PRICING.sonnet;
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
  },
): void {
  const session = getSession(chatId);
  session.usage.totalInputTokens += turn.inputTokens;
  session.usage.totalOutputTokens += turn.outputTokens;
  session.usage.totalCacheRead += turn.cacheRead;
  session.usage.totalCacheWrite += turn.cacheWrite;
  // Snapshot: prompt tokens = input + cache_read + cache_write for this turn
  session.usage.lastPromptTokens =
    turn.inputTokens + turn.cacheRead + turn.cacheWrite;
  // Context window info from SDK (per-iteration data)
  if (turn.contextTokens !== undefined)
    session.usage.contextTokens = turn.contextTokens;
  if (turn.contextWindow !== undefined && turn.contextWindow > 0)
    session.usage.contextWindow = turn.contextWindow;
  if (turn.numApiCalls !== undefined)
    session.usage.numApiCalls = turn.numApiCalls;
  // Model-aware cost estimate
  const pricing = getPricing(turn.model);
  session.usage.estimatedCostUsd +=
    (turn.inputTokens * pricing.input +
      turn.cacheWrite * pricing.cacheWrite +
      turn.cacheRead * pricing.cacheRead +
      turn.outputTokens * pricing.output) /
    1_000_000;
  // Track which model was last used
  if (turn.model) session.lastModel = turn.model;
  // Response time tracking
  if (turn.durationMs && turn.durationMs > 0) {
    session.usage.totalResponseMs =
      (session.usage.totalResponseMs || 0) + turn.durationMs;
    session.usage.lastResponseMs = turn.durationMs;
    const current = session.usage.fastestResponseMs;
    if (turn.durationMs < current) {
      session.usage.fastestResponseMs = turn.durationMs;
    }
  }
  dirty = true;
}

export function setSessionName(chatId: string, name: string): void {
  const session = getSession(chatId);
  session.sessionName = name;
  dirty = true;
}

export function setLastBotMessageId(chatId: string, messageId: number): void {
  const session = getSession(chatId);
  session.lastBotMessageId = messageId;
  dirty = true;
}

export function getLastBotMessageId(chatId: string): number | undefined {
  return store[chatId]?.lastBotMessageId;
}

export function resetSession(chatId: string): void {
  const session = store[chatId];
  const turns = session?.turns ?? 0;
  const name = session?.sessionName;
  delete store[chatId];
  dirty = true;
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
  const session = store[chatId];
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
  return Object.keys(store).length;
}

/** Get all chat IDs with active sessions and their info. */
export function getAllSessions(): Array<{ chatId: string; info: SessionInfo }> {
  return Object.entries(store).map(([chatId, session]) => ({
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

// Flush on exit (signal handlers are in index.ts for graceful shutdown)
registerCleanup(saveSessions);

/** Force-save sessions to disk and stop the auto-save timer. */
export function flushSessions(): void {
  clearInterval(autoSaveTimer);
  dirty = true;
  saveSessions();
}
