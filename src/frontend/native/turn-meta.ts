/**
 * Turn-meta sidecar — persists what each assistant turn *did* (tool calls,
 * duration, token usage) keyed by chat + message id, so the companion app's
 * tool timeline and stats footer survive a history reload or daemon restart.
 *
 * History rows live in SQLite with a fixed schema shared by every frontend;
 * this data is native-frontend-only presentation metadata, so it lives in a
 * small JSON sidecar under the data dir instead of a schema migration.
 * Writes are debounced; each chat keeps a bounded window of recent turns.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { dirs } from "../../util/paths.js";
import { logError } from "../../util/log.js";
import type { ClientToolCall } from "./protocol.js";

export type TurnMeta = {
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  tools?: ClientToolCall[];
};

const FILE = () => join(dirs.data, "native-turn-meta.json");
/** Per-chat cap — matches the /history page ceiling, so hydration covers
 *  everything a client can actually fetch. */
const MAX_PER_CHAT = 500;
const FLUSH_MS = 1_500;

type Store = Record<string, Record<string, TurnMeta>>;

let store: Store | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function load(): Store {
  if (store) return store;
  try {
    const parsed: unknown = JSON.parse(readFileSync(FILE(), "utf-8"));
    store =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Store)
        : {};
  } catch {
    store = {}; // first run / unreadable — start fresh
  }
  return store;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushTurnMeta();
  }, FLUSH_MS);
  flushTimer.unref?.();
}

/** Write-through for shutdown; atomic via rename so a crash can't torch it. */
export function flushTurnMeta(): void {
  if (!store) return;
  try {
    mkdirSync(dirs.data, { recursive: true });
    const tmp = `${FILE()}.tmp`;
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, FILE());
  } catch (err) {
    logError("native", "Failed to persist turn meta", err);
  }
}

/** Record (or extend) the meta for one assistant message. */
export function recordTurnMeta(
  chatId: string,
  msgId: string,
  meta: TurnMeta,
): void {
  const s = load();
  const chat = (s[chatId] ??= {});
  chat[msgId] = { ...chat[msgId], ...meta };
  // Bounded window: drop the oldest entries (numeric-ascending ids).
  const ids = Object.keys(chat);
  if (ids.length > MAX_PER_CHAT) {
    ids
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, ids.length - MAX_PER_CHAT)
      .forEach((id) => delete chat[id]);
  }
  scheduleFlush();
}

/** Look up the meta for one message, or null. */
export function getTurnMeta(chatId: string, msgId: string): TurnMeta | null {
  return load()[chatId]?.[msgId] ?? null;
}

/** Forget a chat entirely (chat deleted / history cleared). */
export function clearTurnMeta(chatId: string): void {
  const s = load();
  if (s[chatId]) {
    delete s[chatId];
    scheduleFlush();
  }
}
