/**
 * Triggers repository — executes the statements in sql/triggers.sql
 * against the `triggers` table; no SQL text lives here. The public
 * store (storage/trigger-store.ts) holds the domain API, validation
 * and the on-disk script/log handling; this module owns statement
 * execution and the row↔domain mapping.
 */

import { getDatabase } from "../db.js";
import { triggersSql } from "../sql/statements.generated.js";
import type {
  Trigger,
  TriggerLanguage,
  TriggerStatus,
} from "../trigger-store.js";

type Row = {
  id: string;
  chat_id: string;
  numeric_chat_id: number;
  name: string;
  language: string;
  script_path: string;
  log_path: string;
  description: string | null;
  status: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  pid: number | null;
  pid_starttime: number | null;
  timeout_seconds: number;
  exit_code: number | null;
  fire_count: number;
  last_fire_at: number | null;
  last_fire_payload: string | null;
  last_error: string | null;
  persistent: number;
  model: string | null;
};

function rowToTrigger(row: Row): Trigger {
  return {
    id: row.id,
    chatId: row.chat_id,
    numericChatId: row.numeric_chat_id,
    name: row.name,
    language: row.language as TriggerLanguage,
    scriptPath: row.script_path,
    logPath: row.log_path,
    description: row.description ?? undefined,
    status: row.status as TriggerStatus,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    pid: row.pid ?? undefined,
    pidStarttime: row.pid_starttime ?? undefined,
    timeoutSeconds: row.timeout_seconds,
    exitCode: row.exit_code ?? undefined,
    fireCount: row.fire_count,
    lastFireAt: row.last_fire_at ?? undefined,
    lastFirePayload: row.last_fire_payload ?? undefined,
    lastError: row.last_error ?? undefined,
    persistent: row.persistent === 1 ? true : undefined,
    model: row.model ?? undefined,
  };
}

export function upsert(t: Trigger): void {
  getDatabase()
    .prepare(triggersSql.upsert)
    .run(
      t.id,
      t.chatId,
      t.numericChatId,
      t.name,
      t.language,
      t.scriptPath,
      t.logPath,
      t.description ?? null,
      t.status,
      t.createdAt,
      t.startedAt ?? null,
      t.endedAt ?? null,
      t.pid ?? null,
      t.pidStarttime ?? null,
      t.timeoutSeconds,
      t.exitCode ?? null,
      t.fireCount || 0,
      t.lastFireAt ?? null,
      t.lastFirePayload ?? null,
      t.lastError ?? null,
      t.persistent ? 1 : 0,
      t.model ?? null,
    );
}

export function get(id: string): Trigger | undefined {
  const row = getDatabase().prepare(triggersSql.get).get(id) as Row | undefined;
  return row ? rowToTrigger(row) : undefined;
}

export function getByName(chatId: string, name: string): Trigger | undefined {
  const row = getDatabase().prepare(triggersSql.getByName).get(chatId, name) as
    Row | undefined;
  return row ? rowToTrigger(row) : undefined;
}

export function listByChat(chatId: string): Trigger[] {
  const rows = getDatabase()
    .prepare(triggersSql.listByChat)
    .all(chatId) as Row[];
  return rows.map(rowToTrigger);
}

export function listAll(): Trigger[] {
  const rows = getDatabase().prepare(triggersSql.listAll).all() as Row[];
  return rows.map(rowToTrigger);
}

export function remove(id: string): boolean {
  const result = getDatabase().prepare(triggersSql.remove).run(id) as {
    changes?: number;
  };
  return (result.changes ?? 0) > 0;
}

/**
 * Restart recovery, both halves (see loadTriggers): returns how many
 * non-persistent triggers were terminated and how many persistent ones
 * were parked in 'pending' for resumeAfterRestart to respawn.
 */
export function recoverInterrupted(now: number): {
  terminated: number;
  parked: number;
} {
  const db = getDatabase();
  const terminated = db.prepare(triggersSql.terminateInterrupted).run(now) as {
    changes?: number;
  };
  const parked = db.prepare(triggersSql.parkInterruptedPersistent).run() as {
    changes?: number;
  };
  return {
    terminated: terminated.changes ?? 0,
    parked: parked.changes ?? 0,
  };
}

export function count(): number {
  const row = getDatabase().prepare(triggersSql.count).get() as { n: number };
  return row.n;
}

/** Test-only: wipe the table between suites sharing a worker DB. */
export function removeAll(): void {
  getDatabase().prepare(triggersSql.removeAll).run();
}
