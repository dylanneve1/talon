/**
 * Cron scheduler — runs persistent recurring jobs.
 *
 * Every 60 seconds, checks all enabled cron jobs. If one is due, executes it.
 * "message" type sends text via injected sendMessage.
 * "query" type runs as an ISOLATED one-shot agent (heartbeat/dream pattern) —
 * its own session, no chat history — so a scheduled task never disturbs the
 * chat session and may run on a different model/provider. The agent delivers
 * to the chat via the messaging tools with an explicit chat_id.
 *
 * Knows nothing about the backend or frontend — dependencies are injected.
 */

import { Cron } from "croner";
import { getActiveCount } from "../engine/dispatcher.js";
import {
  getAllCronJobs,
  recordCronRun,
  type CronJob,
} from "../../storage/cron-store.js";
import { appendDailyLog } from "../../storage/daily-log.js";
import { log, logError, logWarn } from "../../util/log.js";
import { runJobOneShot } from "./job-oneshot.js";
import {
  jobAllowsRun,
  pruneJobHealth,
  recordJobFailure,
  recordJobSuccess,
  type JobHealthOptions,
} from "./job-health.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

type CronDeps = {
  sendMessage: (chatId: number, text: string) => Promise<void>;
  /**
   * Resolve the chat's default model + backend, used when a cron query job has
   * no model/provider override of its own.
   */
  resolveChatModel: (
    chatId: string,
  ) => Promise<{ model: string | null; backendId: string }>;
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

// Job IDs currently executing. Prevents a long-running "query" job from being
// dispatched a second time by the next 60-second tick before recordCronRun()
// has had a chance to update lastRunAt.
const runningJobs = new Set<string>();

type ExecuteJobResult =
  | { status: "ran" }
  | { status: "skipped"; reason: string };

// Per-job circuit breaker policy (Gleam scheduler core via job-health):
// 3 consecutive failures open the breaker; cooldown starts at 5 minutes
// and escalates per re-open up to 6 hours. Without this, a job whose
// target chat is gone (or whose query always faults) fails every
// matching tick forever.
const JOB_HEALTH: JobHealthOptions = {
  threshold: 3,
  baseCooldownMs: 5 * 60_000,
  maxCooldownMs: 6 * 60 * 60_000,
};

async function runCronTick(): Promise<void> {
  if (!deps) return;
  if (getActiveCount() > 10) return; // safety valve — don't pile on if heavily loaded

  const now = new Date();
  const jobs = getAllCronJobs();
  pruneJobHealth(new Set(jobs.map((j) => j.id)));

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (runningJobs.has(job.id)) continue; // already in-flight this tick or a previous one
    if (!isDue(job, now)) continue;
    if (!jobAllowsRun(job.id, now.getTime(), JOB_HEALTH)) {
      log("cron", `Skipping "${job.name}" [${job.id}] — breaker open`);
      continue;
    }
    if (getActiveCount() > 10) break;

    runningJobs.add(job.id);
    try {
      log(
        "cron",
        `Executing "${job.name}" [${job.id}] (${job.type}) in chat ${job.chatId}`,
      );
      const result = await executeJob(job);
      recordJobSuccess(job.id, Date.now(), JOB_HEALTH);
      recordCronRun(job.id);
      appendDailyLog(
        "Cron",
        result.status === "skipped"
          ? `Skipped "${job.name}" (${job.type}) in chat ${job.chatId}: ${result.reason}`
          : `Ran "${job.name}" (${job.type}) in chat ${job.chatId}`,
      );
      if (result.status === "ran") {
        log("cron", `Executed "${job.name}" [${job.id}] in chat ${job.chatId}`);
      }
    } catch (err) {
      logError("cron", `Job "${job.name}" [${job.id}] failed`, err);
      const cooldown = recordJobFailure(job.id, Date.now(), JOB_HEALTH);
      if (cooldown !== null) {
        logWarn(
          "cron",
          `Breaker opened for "${job.name}" [${job.id}] — cooling down ~${Math.round(cooldown / 60_000)}min`,
        );
      }
    } finally {
      runningJobs.delete(job.id);
    }
  }
}

// Track jobs that have already logged a bad-schedule warning to avoid log spam
// (isDue runs every 60s — a single bad job would flood the logs otherwise).
// Capped to prevent unbounded growth from ephemeral job IDs.
const warnedBadSchedule = new Set<string>();
const MAX_WARNED_SCHEDULES = 200;

function isDue(job: CronJob, now: Date): boolean {
  try {
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const cron = new Cron(job.schedule, {
      timezone: job.timezone ?? undefined,
    });

    // Schedule parsed fine — clear stale warning immediately so it can
    // re-trigger if the schedule breaks again later (regardless of whether
    // the job is actually due right now)
    warnedBadSchedule.delete(job.id);

    const next = cron.nextRun(oneMinuteAgo);
    if (!next) return false;

    const nowMinute = Math.floor(now.getTime() / 60_000);
    const nextMinute = Math.floor(next.getTime() / 60_000);
    if (nowMinute !== nextMinute) return false;

    // Prevent duplicate runs — ensure at least 55 seconds since last execution
    if (job.lastRunAt && now.getTime() - job.lastRunAt < 55_000) return false;

    // Guard against backward clock jumps (NTP sync, etc.) — if last run is in the
    // future, skip until the clock catches up
    if (job.lastRunAt && job.lastRunAt > now.getTime()) return false;

    return true;
  } catch (err) {
    if (!warnedBadSchedule.has(job.id)) {
      if (warnedBadSchedule.size >= MAX_WARNED_SCHEDULES) {
        const oldest = warnedBadSchedule.values().next().value;
        if (oldest !== undefined) warnedBadSchedule.delete(oldest);
      }
      warnedBadSchedule.add(job.id);
      logWarn(
        "cron",
        `Invalid cron schedule for job "${job.id}": ${err instanceof Error ? err.message : err}`,
      );
    }
    return false;
  }
}

const CRON_JOB_TIMEOUT_MS = 10 * 60_000; // 10-minute max per job

export async function executeJob(job: CronJob): Promise<ExecuteJobResult> {
  if (!deps) return { status: "skipped", reason: "cron is not initialised" };

  const numericChatId = Number(job.chatId);
  if (!Number.isFinite(numericChatId)) {
    throw new Error(`Invalid chatId for job "${job.name}": ${job.chatId}`);
  }

  if (job.type === "message") {
    await deps.sendMessage(numericChatId, job.content);
    return { status: "ran" };
  }

  // type === "query" — run as an ISOLATED one-shot (no chat session). Resolve
  // the target backend + model: a job-level override wins (and may name a
  // different provider, since the run is isolated), otherwise fall back to the
  // chat's backend + active model.
  let backendId: string;
  let model: string | null;
  if (job.provider) {
    backendId = job.provider;
    model = job.model ?? null;
  } else {
    const chat = await deps.resolveChatModel(job.chatId);
    backendId = chat.backendId;
    model = job.model ?? chat.model;
  }
  if (!model) {
    throw new Error(
      `Cron job "${job.name}": no model resolved for backend "${backendId}" — set a model or pick a model for the chat's backend.`,
    );
  }

  const payload =
    `[System: CRON JOB "${job.name}" (schedule: ${job.schedule}). ` +
    `Execute the task. Be concise and action-oriented.]\n\n${job.content}`;

  // runJobOneShot enforces its own hard timeout (with abort + grace), so no
  // outer withTimeout wrapper is needed here.
  const result = await runJobOneShot({
    chatId: job.chatId,
    backendId,
    model,
    ...(job.instructions ? { instructions: job.instructions } : {}),
    payload,
    label: job.name,
    kind: "cron",
    timeoutMs: CRON_JOB_TIMEOUT_MS,
  });
  if (result.status === "skipped") {
    await deps.sendMessage(
      numericChatId,
      `Cron job "${job.name}" skipped: ${result.reason} Update or delete the job to stop this notice.`,
    );
  }
  return result;
}
