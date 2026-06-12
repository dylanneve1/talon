/**
 * Goals repository — executes the statements in sql/goals.sql against
 * the `goals` table; no SQL text lives here. The public store
 * (storage/goal-store.ts) holds the domain API and validation; this
 * module owns statement execution and the row↔domain mapping.
 */

import { getDatabase } from "../db.js";
import { goalsSql } from "../sql/statements.generated.js";
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

/**
 * Expand the `(/* statuses *​/)` placeholder list in a statement to
 * one `?` per status. The status values themselves stay bound
 * parameters — only the placeholder count is interpolated, never
 * caller data.
 */
function expandStatusPlaceholders(sql: string, count: number): string {
  return sql.replace(
    /\(\/\* statuses \*\/\)/,
    `(${Array.from({ length: count }, () => "?").join(", ")})`,
  );
}

export function upsert(goal: Goal): void {
  getDatabase()
    .prepare(goalsSql.upsert)
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
  const row = getDatabase().prepare(goalsSql.get).get(id) as Row | undefined;
  return row ? rowToGoal(row) : undefined;
}

/** Goals for one chat, optionally filtered by status, newest-updated first. */
export function listByChat(
  chatId: string,
  statuses?: readonly string[],
): Goal[] {
  if (statuses && statuses.length > 0) {
    const rows = getDatabase()
      .prepare(
        expandStatusPlaceholders(goalsSql.listByChatAndStatus, statuses.length),
      )
      .all(chatId, ...statuses) as Row[];
    return rows.map(rowToGoal);
  }
  const rows = getDatabase().prepare(goalsSql.listByChat).all(chatId) as Row[];
  return rows.map(rowToGoal);
}

/** Goals across ALL chats with one of the given statuses (heartbeat scan). */
export function listByStatus(statuses: readonly string[]): Goal[] {
  if (statuses.length === 0) return [];
  const rows = getDatabase()
    .prepare(expandStatusPlaceholders(goalsSql.listByStatus, statuses.length))
    .all(...statuses) as Row[];
  return rows.map(rowToGoal);
}

export function countByChatAndStatus(
  chatId: string,
  statuses: readonly string[],
): number {
  if (statuses.length === 0) return 0;
  const row = getDatabase()
    .prepare(
      expandStatusPlaceholders(goalsSql.countByChatAndStatus, statuses.length),
    )
    .get(chatId, ...statuses) as { n: number };
  return row.n;
}

export function remove(id: string): boolean {
  const result = getDatabase().prepare(goalsSql.remove).run(id) as {
    changes?: number;
  };
  return (result.changes ?? 0) > 0;
}
