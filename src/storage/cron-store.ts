/**
 * Persistent cron job store. In-memory Map with dirty-flag auto-save to workspace/cron.json.
 * Same pattern as chat-settings.ts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Cron } from "croner";
import { log } from "../util/log.js";

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

const STORE_FILE = resolve(process.cwd(), "workspace", "cron.json");
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
    store = {};
  }
  const count = Object.keys(store).length;
  if (count > 0) {
    log("cron", `Loaded ${count} cron job(s)`);
  }
}

function save(): void {
  if (!dirty) return;
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(store, null, 2) + "\n");
    dirty = false;
  } catch {
    // Non-fatal
  }
}

const autoSaveTimer = setInterval(save, 10_000);
process.on("exit", save);

/** Flush cron jobs to disk and stop the auto-save timer. */
export function flushCronJobs(): void {
  clearInterval(autoSaveTimer);
  save();
}

// ── ID generation ───────────────────────────────────────────────────────────

export function generateCronId(): string {
  return `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
      next: nextDate ? nextDate.toISOString() : undefined,
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
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
