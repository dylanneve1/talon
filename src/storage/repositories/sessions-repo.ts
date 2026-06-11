/**
 * Sessions repository — every SQL statement that touches the
 * `sessions` table lives here, and nowhere else. The public store
 * (storage/sessions.ts) holds the domain API and the in-memory
 * write-through cache; this module owns the statements and the
 * row↔domain mapping.
 *
 * One row per chat, real columns for the hot fields (see schema.ts
 * migration 2 for the rationale). `fastest_response_ms` is NULL when
 * no timed turn has been recorded — the domain value is Infinity,
 * which neither JSON nor a sensible column default can hold.
 */

import { getDatabase, inTransaction } from "../db.js";
import type { SessionState } from "../sessions.js";

type Row = {
  chat_id: string;
  session_id: string | null;
  session_name: string | null;
  last_model: string | null;
  turns: number;
  last_active: number;
  created_at: number;
  last_bot_message_id: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_write: number;
  last_prompt_tokens: number;
  context_tokens: number;
  context_window: number;
  num_api_calls: number;
  estimated_cost_usd: number;
  total_response_ms: number;
  last_response_ms: number;
  fastest_response_ms: number | null;
};

const COLUMNS =
  "chat_id, session_id, session_name, last_model, turns, last_active, created_at, " +
  "last_bot_message_id, total_input_tokens, total_output_tokens, total_cache_read, " +
  "total_cache_write, last_prompt_tokens, context_tokens, context_window, " +
  "num_api_calls, estimated_cost_usd, total_response_ms, last_response_ms, " +
  "fastest_response_ms";

function rowToSession(row: Row): SessionState {
  return {
    sessionId: row.session_id ?? undefined,
    turns: row.turns,
    lastActive: row.last_active,
    createdAt: row.created_at,
    usage: {
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalCacheRead: row.total_cache_read,
      totalCacheWrite: row.total_cache_write,
      lastPromptTokens: row.last_prompt_tokens,
      contextTokens: row.context_tokens,
      contextWindow: row.context_window,
      numApiCalls: row.num_api_calls,
      estimatedCostUsd: row.estimated_cost_usd,
      totalResponseMs: row.total_response_ms,
      lastResponseMs: row.last_response_ms,
      // NULL = no timed turn yet — the domain sentinel is Infinity.
      fastestResponseMs: row.fastest_response_ms ?? Infinity,
    },
    lastBotMessageId: row.last_bot_message_id ?? undefined,
    sessionName: row.session_name ?? undefined,
    lastModel: row.last_model ?? undefined,
  };
}

/** Coerce a possibly-absent legacy number into a finite value. */
function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Whole-row write. Tolerates partially-shaped legacy sessions (missing
 * usage object, missing createdAt) by defaulting numerics to 0 — the
 * store's normaliseSession() re-derives the domain values on read.
 */
export function upsert(chatId: string, session: SessionState): void {
  const usage = session.usage;
  const fastest = usage?.fastestResponseMs;
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO sessions (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chatId,
      session.sessionId ?? null,
      session.sessionName ?? null,
      session.lastModel ?? null,
      num(session.turns),
      num(session.lastActive),
      num(session.createdAt),
      session.lastBotMessageId ?? null,
      num(usage?.totalInputTokens),
      num(usage?.totalOutputTokens),
      num(usage?.totalCacheRead),
      num(usage?.totalCacheWrite),
      num(usage?.lastPromptTokens),
      num(usage?.contextTokens),
      num(usage?.contextWindow),
      num(usage?.numApiCalls),
      num(usage?.estimatedCostUsd),
      num(usage?.totalResponseMs),
      num(usage?.lastResponseMs),
      typeof fastest === "number" && Number.isFinite(fastest) ? fastest : null,
    );
}

/** Bulk-upsert inside one transaction (legacy JSON import). */
export function upsertMany(
  entries: Array<{ chatId: string; session: SessionState }>,
): number {
  return inTransaction(() => {
    for (const { chatId, session } of entries) upsert(chatId, session);
    return entries.length;
  });
}

/** Every persisted session — used to prime the in-memory cache. */
export function all(): Array<{ chatId: string; session: SessionState }> {
  const rows = getDatabase()
    .prepare(`SELECT ${COLUMNS} FROM sessions`)
    .all() as Row[];
  return rows.map((row) => ({
    chatId: row.chat_id,
    session: rowToSession(row),
  }));
}

export function remove(chatId: string): void {
  getDatabase().prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
}

/** WAL → main-file compaction; used on shutdown. */
export function checkpoint(): void {
  getDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
