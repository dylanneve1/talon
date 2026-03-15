import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { resolve, dirname } from "node:path";
import { log, logError } from "../util/log.js";

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
  /** Last turn's prompt tokens (context size snapshot). */
  lastPromptTokens: number;
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

const STORE_FILE = resolve(process.cwd(), "workspace", "sessions.json");
let store: SessionStore = {};
let dirty = false;

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}


export function loadSessions(): void {
  try {
    if (existsSync(STORE_FILE)) {
      store = JSON.parse(readFileSync(STORE_FILE, "utf-8"));
    }
  } catch {
    store = {};
  }
}

function saveSessions(): void {
  if (!dirty) return;
  try {
    ensureDir(STORE_FILE);
    // Atomic write: writes to temp file then renames — prevents corruption on crash
    writeFileAtomic.sync(STORE_FILE, JSON.stringify(store, null, 2) + "\n");
    dirty = false;
  } catch (err) {
    logError("sessions", "Failed to persist sessions", err);
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
  estimatedCostUsd: 0,
  totalResponseMs: 0,
  lastResponseMs: 0,
  fastestResponseMs: 0,
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
  if (session.usage.fastestResponseMs === undefined)
    session.usage.fastestResponseMs = 0;
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
    const current = session.usage.fastestResponseMs || Infinity;
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
  delete store[chatId];
  dirty = true;
  saveSessions();
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
      usage: session.usage ?? {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheRead: 0,
        totalCacheWrite: 0,
        lastPromptTokens: 0,
        estimatedCostUsd: 0,
        totalResponseMs: 0,
        lastResponseMs: 0,
        fastestResponseMs: 0,
      },
    },
  }));
}

// Flush on exit (signal handlers are in index.ts for graceful shutdown)
process.on("exit", saveSessions);

/** Force-save sessions to disk and stop the auto-save timer. */
export function flushSessions(): void {
  clearInterval(autoSaveTimer);
  dirty = true;
  saveSessions();
}
