/**
 * Goals repository — every SQL statement that touches the `goals`
 * table lives here, and nowhere else. The public store
 * (storage/goal-store.ts) holds the domain API and validation; this
 * module owns the statements and the row↔domain mapping.
 */

import { getDatabase } from "../db.js";
import type { Goal, GoalPriority, GoalStatus } from "../goal-store.js";

type Row = {
  id: string;
  chat_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  created_at: number;
  updated_at: number;
  due_at: number | null;
  last_progress_note: string | null;
  last_progress_at: number | null;
};

const COLUMNS =
  "id, chat_id, title, description, status, priority, created_at, " +
  "updated_at, due_at, last_progress_note, last_progress_at";

function rowToGoal(row: Row): Goal {
  return {
    id: row.id,
    chatId: row.chat_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as GoalStatus,
    priority: row.priority as GoalPriority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dueAt: row.due_at ?? undefined,
    lastProgressNote: row.last_progress_note ?? undefined,
    lastProgressAt: row.last_progress_at ?? undefined,
  };
}

export function upsert(goal: Goal): void {
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO goals (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      goal.id,
      goal.chatId,
      goal.title,
      goal.description ?? null,
      goal.status,
      goal.priority,
      goal.createdAt,
      goal.updatedAt,
      goal.dueAt ?? null,
      goal.lastProgressNote ?? null,
      goal.lastProgressAt ?? null,
    );
}

export function get(id: string): Goal | undefined {
  const row = getDatabase()
    .prepare(`SELECT ${COLUMNS} FROM goals WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? rowToGoal(row) : undefined;
}

/** Goals for one chat, optionally filtered by status, newest-updated first. */
export function listByChat(
  chatId: string,
  statuses?: readonly string[],
): Goal[] {
  if (statuses && statuses.length > 0) {
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = getDatabase()
      .prepare(
        `SELECT ${COLUMNS} FROM goals
         WHERE chat_id = ? AND status IN (${placeholders})
         ORDER BY updated_at DESC`,
      )
      .all(chatId, ...statuses) as Row[];
    return rows.map(rowToGoal);
  }
  const rows = getDatabase()
    .prepare(
      `SELECT ${COLUMNS} FROM goals WHERE chat_id = ? ORDER BY updated_at DESC`,
    )
    .all(chatId) as Row[];
  return rows.map(rowToGoal);
}

/** Goals across ALL chats with one of the given statuses (heartbeat scan). */
export function listByStatus(statuses: readonly string[]): Goal[] {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => "?").join(", ");
  const rows = getDatabase()
    .prepare(
      `SELECT ${COLUMNS} FROM goals
       WHERE status IN (${placeholders})
       ORDER BY updated_at DESC`,
    )
    .all(...statuses) as Row[];
  return rows.map(rowToGoal);
}

export function countByChatAndStatus(
  chatId: string,
  statuses: readonly string[],
): number {
  if (statuses.length === 0) return 0;
  const placeholders = statuses.map(() => "?").join(", ");
  const row = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS n FROM goals
       WHERE chat_id = ? AND status IN (${placeholders})`,
    )
    .get(chatId, ...statuses) as { n: number };
  return row.n;
}

export function remove(id: string): boolean {
  const result = getDatabase()
    .prepare("DELETE FROM goals WHERE id = ?")
    .run(id) as { changes?: number };
  return (result.changes ?? 0) > 0;
}
