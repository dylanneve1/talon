/**
 * Persistent cron job store.
 *
 * Backed by the unified `JsonStore<T>` primitive: the on-disk
 * format is `{ schemaVersion, savedAt, data: Record<id, CronJob> }`.
 * A migrate hook accepts two legacy shapes:
 *
 *   1. Bare object `{ id1: job1, id2: job2 }` — pre-envelope, the
 *      original storage layout.
 *   2. Bare array `[job1, job2]` — very early storage layout, kept
 *      working since 1.x.
 */

import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Cron } from "croner";
import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { files } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";
import { JsonStore } from "../core/agent-runtime/store.js";

export type CronJobType = "message" | "query";

export type CronJob = {
  id: string;
  chatId: string;
  /** Cron expression (5-field: minute hour day month weekday) */
  schedule: string;
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
};

type CronStoreShape = Record<string, CronJob>;

const STORE_FILE = files.cron;
const SCHEMA_VERSION = 1 as const;

const store = new JsonStore<CronStoreShape>({
  path: STORE_FILE,
  defaultValue: {},
  schemaVersion: SCHEMA_VERSION,
  migrate: (raw, fromVersion) => {
    if (fromVersion !== 0) return null;
    // Legacy array shape.
    if (Array.isArray(raw)) {
      const out: CronStoreShape = {};
      for (const j of raw) {
        if (isCronJob(j)) out[j.id] = j;
      }
      return { value: out, schemaVersion: SCHEMA_VERSION };
    }
    // Legacy bare-object shape.
    if (raw && typeof raw === "object") {
      const out: CronStoreShape = {};
      for (const [id, job] of Object.entries(raw)) {
        if (isCronJob(job)) out[id] = job;
      }
      return { value: out, schemaVersion: SCHEMA_VERSION };
    }
    return { value: {}, schemaVersion: SCHEMA_VERSION };
  },
});

function isCronJob(value: unknown): value is CronJob {
  if (!value || typeof value !== "object") return false;
  const j = value as Record<string, unknown>;
  return (
    typeof j.id === "string" &&
    typeof j.chatId === "string" &&
    typeof j.schedule === "string" &&
    (j.type === "message" || j.type === "query") &&
    typeof j.content === "string" &&
    typeof j.name === "string" &&
    typeof j.enabled === "boolean" &&
    typeof j.createdAt === "number"
  );
}

export function loadCronJobs(): void {
  store.reset();
  try {
    store.loadSync();
  } catch (err) {
    logError("cron", "Failed to load cron jobs", err);
  }

  // Strip invalid IANA timezone strings so Cron() doesn't throw at runtime.
  let invalidTz = 0;
  const data = store.get();
  for (const job of Object.values(data)) {
    if (job.timezone && !isValidTimezone(job.timezone)) {
      log(
        "cron",
        `Job "${job.name}" has invalid timezone "${job.timezone}" — clearing`,
      );
      job.timezone = undefined;
      invalidTz++;
    }
  }
  // Only mark dirty when something actually changed — avoids a
  // needless save tick on every startup.
  if (invalidTz > 0) {
    store.update(() => undefined);
  }

  const count = Object.keys(data).length;
  if (count > 0) {
    log(
      "cron",
      `Loaded ${count} cron job(s)${invalidTz > 0 ? ` (cleared ${invalidTz} invalid timezone(s))` : ""}`,
    );
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

function save(): void {
  if (!store.isDirty()) return;
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    store.saveSync();
  } catch (err) {
    logError("cron", "Failed to persist cron jobs", err);
    recordError(
      `Cron save failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

const autoSaveTimer = setInterval(save, 10_000);
registerCleanup(save);

/** Flush cron jobs to disk and stop the auto-save timer. */
export function flushCronJobs(): void {
  clearInterval(autoSaveTimer);
  // Force a save by marking the store dirty.
  store.update(() => undefined);
  save();
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

// ── CRUD ────────────────────────────────────────────────────────────────────

export function addCronJob(job: CronJob): void {
  store.update((data) => {
    data[job.id] = job;
  });
  save();
}

export function getCronJob(id: string): CronJob | undefined {
  return store.get()[id];
}

export function getCronJobsForChat(chatId: string): CronJob[] {
  return Object.values(store.get()).filter((j) => j.chatId === chatId);
}

export function getAllCronJobs(): CronJob[] {
  return Object.values(store.get());
}

export function updateCronJob(
  id: string,
  updates: Partial<Omit<CronJob, "id" | "chatId" | "createdAt">>,
): CronJob | undefined {
  const existing = store.get()[id];
  if (!existing) return undefined;
  store.update((data) => {
    Object.assign(data[id], updates);
  });
  save();
  return store.get()[id];
}

export function deleteCronJob(id: string): boolean {
  if (!store.get()[id]) return false;
  store.update((data) => {
    delete data[id];
  });
  save();
  return true;
}

export function recordCronRun(id: string): void {
  if (!store.get()[id]) return;
  store.update((data) => {
    const job = data[id];
    if (!job) return;
    job.lastRunAt = Date.now();
    job.runCount = (job.runCount || 0) + 1;
  });
  // Don't force-save on every run; let the interval handle it
}
