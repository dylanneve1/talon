import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

/**
 * Session manager — maps Telegram chat IDs to Claude SDK session IDs.
 * The SDK handles actual conversation storage (JSONL); we just track
 * the mapping so conversations persist across messages.
 *
 * Sessions are persisted to disk so they survive restarts.
 */

type SessionState = {
  /** Claude SDK server-side session ID. */
  sessionId: string | undefined;
  /** Turn count. */
  turns: number;
  /** Last activity timestamp. */
  lastActive: number;
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

export function getSession(chatId: string): SessionState {
  let session = store[chatId];
  if (!session) {
    session = { sessionId: undefined, turns: 0, lastActive: Date.now() };
    store[chatId] = session;
  }
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

export function resetSession(chatId: string): void {
  delete store[chatId];
  dirty = true;
  saveSessions();
}

export function getSessionInfo(chatId: string): {
  sessionId: string | undefined;
  turns: number;
  lastActive: number;
} {
  const session = store[chatId];
  return {
    sessionId: session?.sessionId,
    turns: session?.turns ?? 0,
    lastActive: session?.lastActive ?? 0,
  };
}

export function getActiveSessionCount(): number {
  return Object.keys(store).length;
}

// Flush on exit
process.on("exit", saveSessions);
process.on("SIGINT", () => { saveSessions(); process.exit(0); });
process.on("SIGTERM", () => { saveSessions(); process.exit(0); });
