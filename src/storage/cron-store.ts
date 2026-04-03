/**
 * Persistent cron job store. In-memory Map with dirty-flag auto-save to workspace/cron.json.
 * Same pattern as chat-settings.ts.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import writeFileAtomic from "write-file-atomic";
import { dirname } from "node:path";
import { Cron } from "croner";
import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { files } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";

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

const STORE_FILE = files.cron;
let store: Record<string, CronJob> = {};
let dirty = false;

export function loadCronJobs(): void {
  try {
    if (existsSync(STORE_FILE)) {
      const raw = JSON.parse(readFileSync(STORE_FILE, "utf-8"));
      // Support both array (legacy) and object formats
      if (Array.isArray(raw)) {
        for (const job of raw) store[job.id] = job;
      } else {
        store = raw;
      }
    }
  } catch {
    // Primary corrupt — try backup
    const bakFile = STORE_FILE + ".bak";
    try {
      if (existsSync(bakFile)) {
        const raw = JSON.parse(readFileSync(bakFile, "utf-8"));
        store = Array.isArray(raw)
          ? Object.fromEntries(raw.map((j: CronJob) => [j.id, j]))
          : raw;
        log("cron", "Loaded from backup (primary was corrupt)");
      }
    } catch {
      /* backup also corrupt */
    }
  }
  // Validate and strip invalid IANA timezone strings so Cron() doesn't throw at runtime
  let invalidTz = 0;
  for (const job of Object.values(store)) {
    if (job.timezone && !isValidTimezone(job.timezone)) {
      log(
        "cron",
        `Job "${job.name}" has invalid timezone "${job.timezone}" — clearing`,
      );
      job.timezone = undefined;
      dirty = true;
      invalidTz++;
    }
  }

  const count = Object.keys(store).length;
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
  if (!dirty) return;
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = JSON.stringify(store, null, 2) + "\n";
    if (existsSync(STORE_FILE)) {
      try {
        writeFileAtomic.sync(STORE_FILE + ".bak", readFileSync(STORE_FILE));
      } catch {
        /* best effort */
      }
    }
    writeFileAtomic.sync(STORE_FILE, data);
    dirty = false;
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
      next: (nextDate as Date).toISOString(),
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
  store[job.id] = job;
  dirty = true;
  save();
}

export function getCronJob(id: string): CronJob | undefined {
  return store[id];
}

export function getCronJobsForChat(chatId: string): CronJob[] {
  return Object.values(store).filter((j) => j.chatId === chatId);
}

export function getAllCronJobs(): CronJob[] {
  return Object.values(store);
}

export function updateCronJob(
  id: string,
  updates: Partial<Omit<CronJob, "id" | "chatId" | "createdAt">>,
): CronJob | undefined {
  const job = store[id];
  if (!job) return undefined;
  Object.assign(job, updates);
  dirty = true;
  save();
  return job;
}

export function deleteCronJob(id: string): boolean {
  if (!store[id]) return false;
  delete store[id];
  dirty = true;
  save();
  return true;
}

export function recordCronRun(id: string): void {
  const job = store[id];
  if (!job) return;
  job.lastRunAt = Date.now();
  job.runCount = (job.runCount || 0) + 1;
  dirty = true;
  // Don't force-save on every run; let the interval handle it
}
