/**
 * Cron scheduler — runs persistent recurring jobs.
 *
 * Every 60 seconds, checks all enabled cron jobs. If one is due, executes it.
 * "message" type sends text via injected sendMessage.
 * "query" type goes through the dispatcher with full tool access.
 *
 * Knows nothing about the backend or frontend — dependencies are injected.
 */

import { Cron } from "croner";
import { isBusy, execute } from "./dispatcher.js";
import {
  getAllCronJobs,
  recordCronRun,
  type CronJob,
} from "../storage/cron-store.js";
import { appendDailyLog } from "../storage/daily-log.js";
import { log, logError } from "../util/log.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

type CronDeps = {
  sendMessage: (chatId: number, text: string) => Promise<void>;
};

let deps: CronDeps | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const TICK_INTERVAL_MS = 60_000;

// ── Public API ───────────────────────────────────────────────────────────────

export function initCron(d: CronDeps): void {
  deps = d;
}

export function startCronTimer(): void {
  if (timer) return;
  log("cron", "Started: checking every 60s");
  timer = setInterval(() => {
    runCronTick().catch((err) => logError("cron", "Tick failed", err));
  }, TICK_INTERVAL_MS);
}

export function stopCronTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function runCronTick(): Promise<void> {
  if (!deps) return;
  if (isBusy()) return;

  const now = new Date();
  const jobs = getAllCronJobs();

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!isDue(job, now)) continue;
    if (isBusy()) break;

    try {
      log("cron", `Executing "${job.name}" [${job.id}] (${job.type}) in chat ${job.chatId}`);
      await executeJob(job);
      recordCronRun(job.id);
      appendDailyLog("Cron", `Ran "${job.name}" (${job.type}) in chat ${job.chatId}`);
      log("cron", `Executed "${job.name}" [${job.id}] in chat ${job.chatId}`);
    } catch (err) {
      logError("cron", `Job "${job.name}" [${job.id}] failed`, err);
    }
  }
}

function isDue(job: CronJob, now: Date): boolean {
  try {
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const cron = new Cron(job.schedule, { timezone: job.timezone ?? undefined });
    const next = cron.nextRun(oneMinuteAgo);
    if (!next) return false;

    const nowMinute = Math.floor(now.getTime() / 60_000);
    const nextMinute = Math.floor(next.getTime() / 60_000);
    if (nowMinute !== nextMinute) return false;

    if (job.lastRunAt) {
      const lastMinute = Math.floor(job.lastRunAt / 60_000);
      if (lastMinute === nowMinute) return false;
    }

    return true;
  } catch {
    return false;
  }
}

const CRON_JOB_TIMEOUT_MS = 30 * 60_000; // 30-minute max per job

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function executeJob(job: CronJob): Promise<void> {
  if (!deps) return;

  const numericChatId = parseInt(job.chatId, 10);
  if (isNaN(numericChatId)) {
    logError("cron", `Invalid chatId for job "${job.name}": ${job.chatId}`);
    return;
  }

  if (job.type === "message") {
    await deps.sendMessage(numericChatId, job.content);
    return;
  }

  // type === "query" — run through dispatcher with full tool access, timeout-protected
  const prompt =
    `[System: CRON JOB "${job.name}" (schedule: ${job.schedule}). ` +
    `Execute the task. Be concise and action-oriented.]\n\n${job.content}`;

  await withTimeout(
    execute({
      chatId: job.chatId,
      numericChatId,
      prompt,
      senderName: "Cron",
      isGroup: false,
      source: "cron",
    }),
    CRON_JOB_TIMEOUT_MS,
    `Cron job "${job.name}"`,
  );
}
