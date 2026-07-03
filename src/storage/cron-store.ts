/**
 * Persistent cron job store, backed by the `cron_jobs` table.
 *
 * Low-frequency data: the scheduler scans jobs once a minute and the
 * frontends list per chat, so reads go straight to the DB — no cache,
 * no flush timer (writes commit transactionally, replacing the JSON
 * era's rewrite-the-whole-file autosave). The one-shot legacy import
 * accepts three historical cron.json shapes: the JsonStore envelope,
 * the pre-envelope bare object `{ id: job }`, and the original bare
 * array `[job, ...]`.
 */

import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { files } from "../util/paths.js";
import { importLegacyJson } from "./legacy-import.js";
import { inTransaction } from "./db.js";
import * as repo from "./repositories/cron-repo.js";
import { nextDueMs, type CatchupPolicy } from "../native/scheduler-core.js";

export type CronJobType = "message" | "query";
export type { CatchupPolicy };

/** Outcome of the most recent execution — surfaced in list_cron_jobs. */
export type CronRunStatus = "ok" | "error";

export type CronJob = {
  id: string;
  chatId: string;
  /**
   * Cron expression (5-field: minute hour day month weekday). Optional — a job
   * carries EITHER `schedule` (cron mode) OR `everyMs` (interval mode), never
   * both. The store validator (`isCronJob`) enforces exactly one.
   */
  schedule?: string;
  /**
   * Fixed interval in milliseconds (interval mode). Mutually exclusive with
   * `schedule`. The job fires roughly every `everyMs` after its anchor
   * (`lastRunAt`, else `startAt`, else `createdAt`). Wires the native
   * scheduler-core interval math (next-due + missed-run catch-up) directly.
   */
  everyMs?: number;
  /** "message" sends content as text; "query" runs content as a Claude prompt with tools */
  type: CronJobType;
  /** The message text or query prompt */
  content: string;
  /** Human-readable name for the job */
  name: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  runCount: number;
  /** IANA timezone (e.g. "America/New_York"). Defaults to system timezone. */
  timezone?: string;
  /**
   * Optional model override for `query` jobs. Unset = the chat's model. `query`
   * cron jobs run as an isolated one-shot (no chat session), so unlike triggers
   * the model may be on a different provider — see `provider`.
   */
  model?: string;
  /**
   * Optional provider/backend id for the override (e.g. a cheaper provider than
   * the chat). Requires `model`. Unset = the chat's backend. Since cron runs
   * isolated, a different provider is fine here.
   */
  provider?: string;
  /**
   * Optional short brief that becomes the isolated agent's system prompt — what
   * the job is and how to do it. Useful to orient a cheaper override model.
   */
  instructions?: string;
  /**
   * Don't fire before this epoch-ms instant (a delayed start / "not before").
   * Unset = eligible immediately.
   */
  startAt?: number;
  /**
   * Don't fire after this epoch-ms instant; the job auto-disables once now
   * passes it (a natural expiry / "until"). Unset = no end.
   */
  endAt?: number;
  /**
   * Auto-disable after this many total runs (`runCount >= maxRuns`). A value of
   * 1 makes the job one-shot. Unset = unbounded.
   */
  maxRuns?: number;
  /**
   * Missed-run policy for runs that were due while Talon was down:
   *   "skip" (default) — drop them, resume on the next due tick
   *   "once"           — collapse any number of missed runs into a single catch-up
   *   "all"            — replay every missed run, capped by CATCHUP_MAX
   * Decided by the native scheduler-core `catchupRunCount`.
   */
  catchup?: CatchupPolicy;
  /** Status of the most recent execution. */
  lastStatus?: CronRunStatus;
  /** Error message from the most recent failed execution (cleared on success). */
  lastError?: string;
  /** Wall-clock duration of the most recent execution, in ms. */
  lastDurationMs?: number;
};

/** Telemetry recorded after each execution attempt. */
export type CronRunOutcome = {
  status: CronRunStatus;
  error?: string;
  durationMs?: number;
};

function isCronJob(value: unknown): value is CronJob {
  if (!value || typeof value !== "object") return false;
  const j = value as Record<string, unknown>;
  // A job is scheduled by EITHER a cron expression OR a fixed interval, never
  // both. Legacy jobs always have `schedule`; interval jobs have `everyMs > 0`.
  // Enforce true XOR so a corrupt/hand-edited doc carrying both fields is
  // rejected on import rather than silently running as an interval.
  const hasSchedule = typeof j.schedule === "string" && j.schedule.length > 0;
  const hasInterval = typeof j.everyMs === "number" && j.everyMs > 0;
  return (
    typeof j.id === "string" &&
    typeof j.chatId === "string" &&
    hasSchedule !== hasInterval &&
    (j.type === "message" || j.type === "query") &&
    typeof j.content === "string" &&
    typeof j.name === "string" &&
    typeof j.enabled === "boolean" &&
    typeof j.createdAt === "number"
  );
}

/** True when a job uses interval mode (`everyMs`) rather than a cron expression. */
export function isIntervalJob(job: CronJob): boolean {
  return typeof job.everyMs === "number" && job.everyMs > 0;
}

/**
 * One-shot legacy import + startup hygiene. Invalid IANA timezones are
 * cleared (legacy files could carry hand-edited values that would make
 * Cron() throw at runtime); the sweep also covers rows already in the
 * DB so a bad value never survives a boot.
 */
export function loadCronJobs(): void {
  try {
    importLegacyJson({
      path: files.cron,
      category: "cron",
      what: "cron job(s)",
      ingest: (data) => {
        const jobs = Array.isArray(data)
          ? data
          : data && typeof data === "object"
            ? Object.values(data)
            : [];
        let imported = 0;
        inTransaction(() => {
          for (const job of jobs) {
            if (!isCronJob(job)) continue;
            repo.upsert(job);
            imported++;
          }
        });
        return imported;
      },
    });

    let invalidTz = 0;
    for (const job of repo.listAll()) {
      if (job.timezone && !isValidTimezone(job.timezone)) {
        log(
          "cron",
          `Job "${job.name}" has invalid timezone "${job.timezone}" — clearing`,
        );
        repo.upsert({ ...job, timezone: undefined });
        invalidTz++;
      }
    }

    const count = repo.count();
    if (count > 0) {
      log(
        "cron",
        `Loaded ${count} cron job(s)${invalidTz > 0 ? ` (cleared ${invalidTz} invalid timezone(s))` : ""}`,
      );
    }
  } catch (err) {
    logError("cron", "Failed to load cron jobs", err);
  }
}

/** Check if an IANA timezone string is valid using the Intl API. */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── ID generation ───────────────────────────────────────────────────────────

/** Generate a collision-free cron job ID using the platform's CSPRNG. */
export function generateCronId(): string {
  return `cron_${randomUUID()}`;
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateCronExpression(
  expr: string,
  timezone?: string,
): { valid: boolean; error?: string; next?: string } {
  try {
    const cron = new Cron(expr, { timezone: timezone ?? undefined });
    const nextDate = cron.nextRun();
    return {
      valid: true,
      next: nextDate?.toISOString(),
    };
  } catch (err) {
    return {
      valid: false,
      error: (err as Error).message,
    };
  }
}

// ── Schedule helpers (shared by the scheduler and the gateway) ───────────────

/** The instant an interval job's clock counts from. */
export function intervalAnchor(job: CronJob): number {
  return job.lastRunAt ?? job.startAt ?? job.createdAt;
}

/**
 * Next fire time (epoch ms) at or after `fromMs`, honoring startAt/endAt — or
 * null when the job will never fire again (past endAt, or an unparseable cron
 * expression). Pure: a single source of truth shared by the scheduler's due
 * check and the gateway's "next run" display so the two never disagree.
 */
export function nextRunAt(job: CronJob, fromMs = Date.now()): number | null {
  // Never fire before startAt: count from it when it's still in the future.
  const floor = job.startAt && job.startAt > fromMs ? job.startAt : fromMs;
  let next: number | null = null;

  if (isIntervalJob(job)) {
    // nextDueMs gives the first multiple of everyMs strictly after its 3rd arg,
    // anchored at the job's last fire; floor-1 makes "at or after floor".
    next = nextDueMs(intervalAnchor(job), job.everyMs as number, floor - 1);
  } else if (job.schedule) {
    try {
      const cron = new Cron(job.schedule, {
        timezone: job.timezone ?? undefined,
      });
      const d = cron.nextRun(new Date(floor - 1));
      next = d ? d.getTime() : null;
    } catch {
      next = null;
    }
  }

  if (next === null) return null;
  if (job.endAt && next > job.endAt) return null;
  return next;
}

/** Compact human description of a job's cadence for list output. */
export function describeSchedule(job: CronJob): string {
  if (isIntervalJob(job)) return `every ${humanizeMs(job.everyMs as number)}`;
  return job.schedule ?? "(no schedule)";
}

/** Render a millisecond duration as a compact human string (e.g. "90m", "2h"). */
export function humanizeMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = m / 60;
  if (h < 24)
    return Number.isInteger(h) ? `${h}h` : `${(ms / 3_600_000).toFixed(1)}h`;
  const d = h / 24;
  return Number.isInteger(d) ? `${d}d` : `${(ms / 86_400_000).toFixed(1)}d`;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function addCronJob(job: CronJob): void {
  repo.upsert(job);
}

export function getCronJob(id: string): CronJob | undefined {
  return repo.get(id);
}

export function getCronJobsForChat(chatId: string): CronJob[] {
  return repo.listByChat(chatId);
}

export function getAllCronJobs(): CronJob[] {
  return repo.listAll();
}

/**
 * Merge `updates` into the stored job. A key present with value
 * `undefined` clears that field (Object.assign semantics, matching the
 * in-memory era — callers rely on it to drop e.g. a timezone).
 */
export function updateCronJob(
  id: string,
  updates: Partial<Omit<CronJob, "id" | "chatId" | "createdAt">>,
): CronJob | undefined {
  return inTransaction(() => {
    const existing = repo.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...updates };
    repo.upsert(merged);
    return merged;
  });
}

export function deleteCronJob(id: string): boolean {
  return repo.remove(id);
}

/**
 * Record an execution: bump lastRunAt + runCount and, when an outcome is
 * supplied, persist the last-run telemetry (status/error/duration) surfaced in
 * list_cron_jobs. `at` overrides the run timestamp (defaults to now).
 * Runs inside the scheduler tick — a storage failure must not kill it.
 */
export function recordCronRun(
  id: string,
  outcome?: CronRunOutcome,
  at?: number,
): void {
  try {
    inTransaction(() => {
      const job = repo.get(id);
      if (!job) return;
      job.lastRunAt = at ?? Date.now();
      job.runCount = (job.runCount || 0) + 1;
      if (outcome) {
        job.lastStatus = outcome.status;
        job.lastDurationMs = outcome.durationMs;
        // Keep the failing message visible; clear it on the next success so a
        // stale error doesn't linger after the job recovers.
        job.lastError = outcome.status === "error" ? outcome.error : undefined;
      }
      repo.upsert(job);
    });
  } catch (err) {
    logError("cron", "Failed to record cron run", err);
    recordError(
      `Cron run record failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Test-only: wipe the table between suites sharing a worker DB. */
export function _resetCronJobsForTesting(): void {
  repo.removeAll();
}
