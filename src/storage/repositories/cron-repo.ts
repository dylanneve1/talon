/**
 * Cron repository — executes the statements in sql/cron.sql against
 * the `cron_jobs` table; no SQL text lives here. The public store
 * (storage/cron-store.ts) holds the domain API and validation; this
 * module owns statement execution and the row↔domain mapping.
 */

import { getDatabase } from "../db.js";
import { cronSql } from "../sql/statements.generated.js";
import type {
  CatchupPolicy,
  CronJob,
  CronJobType,
  CronRunStatus,
} from "../cron-store.js";

type Row = {
  id: string;
  chat_id: string;
  name: string;
  type: string;
  content: string;
  enabled: number;
  schedule: string | null;
  every_ms: number | null;
  timezone: string | null;
  model: string | null;
  provider: string | null;
  instructions: string | null;
  start_at: number | null;
  end_at: number | null;
  max_runs: number | null;
  catchup: string | null;
  created_at: number;
  last_run_at: number | null;
  run_count: number;
  last_status: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
};

function rowToJob(row: Row): CronJob {
  return {
    id: row.id,
    chatId: row.chat_id,
    name: row.name,
    type: row.type as CronJobType,
    content: row.content,
    enabled: row.enabled === 1,
    schedule: row.schedule ?? undefined,
    everyMs: row.every_ms ?? undefined,
    timezone: row.timezone ?? undefined,
    model: row.model ?? undefined,
    provider: row.provider ?? undefined,
    instructions: row.instructions ?? undefined,
    startAt: row.start_at ?? undefined,
    endAt: row.end_at ?? undefined,
    maxRuns: row.max_runs ?? undefined,
    catchup: (row.catchup as CatchupPolicy | null) ?? undefined,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at ?? undefined,
    runCount: row.run_count,
    lastStatus: (row.last_status as CronRunStatus | null) ?? undefined,
    lastError: row.last_error ?? undefined,
    lastDurationMs: row.last_duration_ms ?? undefined,
  };
}

export function upsert(job: CronJob): void {
  getDatabase()
    .prepare(cronSql.upsert)
    .run(
      job.id,
      job.chatId,
      job.name,
      job.type,
      job.content,
      job.enabled ? 1 : 0,
      job.schedule ?? null,
      job.everyMs ?? null,
      job.timezone ?? null,
      job.model ?? null,
      job.provider ?? null,
      job.instructions ?? null,
      job.startAt ?? null,
      job.endAt ?? null,
      job.maxRuns ?? null,
      job.catchup ?? null,
      job.createdAt,
      job.lastRunAt ?? null,
      job.runCount || 0,
      job.lastStatus ?? null,
      job.lastError ?? null,
      job.lastDurationMs ?? null,
    );
}

export function get(id: string): CronJob | undefined {
  const row = getDatabase().prepare(cronSql.get).get(id) as Row | undefined;
  return row ? rowToJob(row) : undefined;
}

export function listByChat(chatId: string): CronJob[] {
  const rows = getDatabase().prepare(cronSql.listByChat).all(chatId) as Row[];
  return rows.map(rowToJob);
}

export function listAll(): CronJob[] {
  const rows = getDatabase().prepare(cronSql.listAll).all() as Row[];
  return rows.map(rowToJob);
}

export function remove(id: string): boolean {
  const result = getDatabase().prepare(cronSql.remove).run(id) as {
    changes?: number;
  };
  return (result.changes ?? 0) > 0;
}

export function count(): number {
  const row = getDatabase().prepare(cronSql.count).get() as { n: number };
  return row.n;
}

/** Test-only: wipe the table between suites sharing a worker DB. */
export function removeAll(): void {
  getDatabase().prepare(cronSql.removeAll).run();
}
