import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

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
    writeFileSync(STORE_FILE, JSON.stringify(store, null, 2) + "\n");
    dirty = false;
  } catch (err) {
    console.error("Failed to persist sessions:", err);
  }
}

// Auto-save every 10 seconds if dirty
setInterval(saveSessions, 10_000);

const emptyUsage = (): SessionUsage => ({
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  lastPromptTokens: 0,
  estimatedCostUsd: 0,
});

export function getSession(chatId: string): SessionState {
  let session = store[chatId];
  if (!session) {
    const now = Date.now();
    session = { sessionId: undefined, turns: 0, lastActive: now, createdAt: now, usage: emptyUsage() };
    store[chatId] = session;
  }
  // Migrate old sessions without usage
  if (!session.usage) session.usage = emptyUsage();
  if (!session.createdAt) session.createdAt = session.lastActive;
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

export function recordUsage(
  chatId: string,
  turn: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number },
): void {
  const session = getSession(chatId);
  session.usage.totalInputTokens += turn.inputTokens;
  session.usage.totalOutputTokens += turn.outputTokens;
  session.usage.totalCacheRead += turn.cacheRead;
  session.usage.totalCacheWrite += turn.cacheWrite;
  // Snapshot: prompt tokens = input + cache_read + cache_write for this turn
  session.usage.lastPromptTokens = turn.inputTokens + turn.cacheRead + turn.cacheWrite;
  // Rough cost estimate (Sonnet 4.6 pricing: $3/M input, $15/M output, $0.30/M cache read)
  session.usage.estimatedCostUsd +=
    (turn.inputTokens * 3 + turn.cacheWrite * 3.75 + turn.cacheRead * 0.3 + turn.outputTokens * 15) / 1_000_000;
  dirty = true;
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
};

export function getSessionInfo(chatId: string): SessionInfo {
  const session = store[chatId];
  return {
    sessionId: session?.sessionId,
    turns: session?.turns ?? 0,
    lastActive: session?.lastActive ?? 0,
    createdAt: session?.createdAt ?? 0,
    usage: session?.usage ?? emptyUsage(),
  };
}

export function getActiveSessionCount(): number {
  return Object.keys(store).length;
}

// Flush on exit
process.on("exit", saveSessions);
process.on("SIGINT", () => { saveSessions(); process.exit(0); });
process.on("SIGTERM", () => { saveSessions(); process.exit(0); });
