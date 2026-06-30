/**
 * Cron scheduler — runs persistent recurring jobs.
 *
 * Every 60 seconds, checks all enabled jobs. If one is due, executes it.
 * "message" type sends text via injected sendMessage.
 * "query" type runs as an ISOLATED one-shot agent (heartbeat/dream pattern) —
 * its own session, no chat history — so a scheduled task never disturbs the
 * chat session and may run on a different model/provider. The agent delivers
 * to the chat via the messaging tools with an explicit chat_id.
 *
 * A job is scheduled by EITHER a 5-field cron expression (`schedule`) OR a
 * fixed interval (`everyMs`). On top of cadence it supports lifecycle bounds —
 * a not-before (`startAt`), an expiry (`endAt`), a run cap (`maxRuns`, =1 for
 * one-shot) — and a missed-run catch-up policy (`catchup`) that replays runs
 * that were due while Talon was down. The cadence/catch-up arithmetic comes
 * from the native Gleam scheduler-core; this module is the runtime that wires
 * it to real executions, persistence, and the circuit breaker.
 *
 * Knows nothing about the backend or frontend — dependencies are injected.
 */

import { Cron } from "croner";
import { getActiveCount } from "../engine/dispatcher.js";
import {
  getAllCronJobs,
  getCronJob,
  recordCronRun,
  updateCronJob,
  intervalAnchor,
  isIntervalJob,
  describeSchedule,
  type CronJob,
  type CronRunOutcome,
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
import {
  catchupRunCount,
  missedRunCount,
} from "../../native/scheduler-core.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

type CronDeps = {
  sendMessage: (
    chatId: number,
    text: string,
    stringId?: string,
  ) => Promise<void>;
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

// Upper bound on how many missed runs a single job replays on startup
// catch-up under the "all" policy — so a job idle through a long outage
// fires a handful of times, not hundreds.
const CATCHUP_MAX = 5;

async function runCronTick(): Promise<void> {
  if (!deps) return;
  if (getActiveCount() > 10) return; // safety valve — don't pile on if heavily loaded

  const now = new Date();
  const nowMs = now.getTime();
  const jobs = getAllCronJobs();
  pruneJobHealth(new Set(jobs.map((j) => j.id)));

  for (const job of jobs) {
    if (!job.enabled) continue;
    // Expiry takes priority over dueness: a job past its end time is disabled
    // and skipped even if this minute would otherwise match.
    if (expireIfPast(job, nowMs)) continue;
    if (runningJobs.has(job.id)) continue; // already in-flight this tick or a previous one
    if (!isDue(job, now)) continue;
    if (!jobAllowsRun(job.id, nowMs, JOB_HEALTH)) {
      log("cron", `Skipping "${job.name}" [${job.id}] — breaker open`);
      continue;
    }
    if (getActiveCount() > 10) break;

    await runScheduled(job);
  }
}

/**
 * Execute one job and settle all its bookkeeping: circuit breaker, run
 * telemetry (status/duration/error), daily log, and the run-cap check. Holds
 * the per-job in-flight lock for the duration. Never throws — failures are
 * recorded and swallowed. Shared by the tick, startup catch-up, and run-now.
 */
async function runScheduled(job: CronJob): Promise<void> {
  if (runningJobs.has(job.id)) return;
  runningJobs.add(job.id);
  const startedAt = Date.now();
  try {
    log(
      "cron",
      `Executing "${job.name}" [${job.id}] (${job.type}) in chat ${job.chatId}`,
    );
    const result = await executeJob(job);
    const outcome: CronRunOutcome = {
      status: "ok",
      durationMs: Date.now() - startedAt,
    };
    recordJobSuccess(job.id, Date.now(), JOB_HEALTH);
    recordCronRun(job.id, outcome);
    appendDailyLog(
      "Cron",
      result.status === "skipped"
        ? `Skipped "${job.name}" (${job.type}) in chat ${job.chatId}: ${result.reason}`
        : `Ran "${job.name}" (${job.type}) in chat ${job.chatId}`,
    );
    if (result.status === "ran") {
      log("cron", `Executed "${job.name}" [${job.id}] in chat ${job.chatId}`);
    }
    enforceRunCap(job.id);
  } catch (err) {
    // Advance lastRunAt on failure too (without bumping runCount — failed runs
    // don't count toward maxRuns). For interval jobs the anchor IS lastRunAt, so
    // skipping this would make a flaky job re-fire every 60s tick until the
    // breaker opens, instead of honoring its everyMs cadence between retries.
    updateCronJob(job.id, {
      lastRunAt: Date.now(),
      lastStatus: "error",
      lastError: err instanceof Error ? err.message : String(err),
      lastDurationMs: Date.now() - startedAt,
    });
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

// ── Lifecycle bounds ─────────────────────────────────────────────────────────

/**
 * Disable a job that has reached its run cap (`maxRuns`; =1 means one-shot).
 * Call after a successful run, once runCount has been bumped.
 */
function enforceRunCap(id: string): void {
  const job = getCronJob(id);
  if (!job || !job.enabled) return;
  if (job.maxRuns !== undefined && job.runCount >= job.maxRuns) {
    updateCronJob(id, { enabled: false });
    log(
      "cron",
      `Job "${job.name}" [${id}] reached run cap (${job.maxRuns}) — disabled`,
    );
    appendDailyLog(
      "Cron",
      `Job "${job.name}" finished after ${job.runCount} run(s)`,
    );
  }
}

/**
 * Disable a job whose `endAt` has passed. Returns true when it expired this
 * call (so the caller can skip it for the rest of the tick).
 */
function expireIfPast(job: CronJob, nowMs: number): boolean {
  if (job.endAt !== undefined && nowMs > job.endAt) {
    updateCronJob(job.id, { enabled: false });
    log("cron", `Job "${job.name}" [${job.id}] passed its end time — disabled`);
    appendDailyLog("Cron", `Job "${job.name}" expired (reached end time)`);
    return true;
  }
  return false;
}

// ── Startup catch-up ─────────────────────────────────────────────────────────

/**
 * Replay runs that were due while Talon was down. Called once on startup after
 * the dispatcher and frontend are wired. Honors each job's `catchup` policy
 * (default "skip" = no-op, so jobs created before this feature are unaffected).
 * The native scheduler-core decides how many runs to replay; "all" is capped
 * at CATCHUP_MAX.
 */
export async function runStartupCatchup(): Promise<void> {
  if (!deps) return;
  const nowMs = Date.now();
  for (const job of getAllCronJobs()) {
    // Same load back-pressure the tick honors — don't pile replays onto an
    // already-busy startup.
    if (getActiveCount() > 10) break;
    if (!job.enabled) continue;
    const policy = job.catchup ?? "skip";
    if (policy === "skip") continue;
    if (expireIfPast(job, nowMs)) continue;
    if (job.startAt !== undefined && nowMs < job.startAt) continue;

    const missed = countMissedRuns(job, nowMs);
    const toRun = catchupRunCount(missed, policy, CATCHUP_MAX);
    if (toRun <= 0) continue;

    // Replays collapse to "now" by design: each runScheduled stamps lastRunAt =
    // now, so after the (capped) replays the job resumes cleanly from the
    // present rather than chasing every historical slot. The first replay takes
    // the in-flight lock before yielding, so a concurrent tick can't double-fire.

    log(
      "cron",
      `Catch-up: "${job.name}" [${job.id}] missed ${missed} run(s), replaying ${toRun} (${policy})`,
    );
    appendDailyLog(
      "Cron",
      `Catch-up replayed ${toRun} missed run(s) of "${job.name}"`,
    );
    for (let i = 0; i < toRun; i++) {
      // Re-read each iteration: a run-cap or expiry hit mid-replay must stop us.
      const fresh = getCronJob(job.id);
      if (!fresh || !fresh.enabled) break;
      await runScheduled(fresh);
    }
  }
}

/**
 * How many fire times were missed in (anchor, now] — the input to the catch-up
 * policy. Interval jobs use the native missed-run math; cron jobs walk fire
 * times from the anchor, capped so a long-idle job stays cheap to evaluate.
 */
function countMissedRuns(job: CronJob, nowMs: number): number {
  const anchor = intervalAnchor(job);
  if (isIntervalJob(job)) {
    return missedRunCount(anchor, job.everyMs as number, nowMs);
  }
  if (!job.schedule) return 0;
  try {
    const cron = new Cron(job.schedule, {
      timezone: job.timezone ?? undefined,
    });
    let count = 0;
    let cursor = cron.nextRun(new Date(anchor));
    // `< CATCHUP_MAX` so the walk stops at the cap exactly (a lower bound for a
    // long outage); catchupRunCount applies the same cap to the replay count.
    while (cursor && cursor.getTime() <= nowMs && count < CATCHUP_MAX) {
      count++;
      cursor = cron.nextRun(cursor);
    }
    return count;
  } catch {
    return 0;
  }
}

// ── Run now (manual trigger) ─────────────────────────────────────────────────

/**
 * Execute a job immediately, bypassing its schedule and circuit breaker — for
 * manual "run now" testing. The run is still recorded (telemetry + run cap), so
 * a one-shot run-now also retires the job. Returns an error string if the job
 * is missing or already running.
 */
export async function runJobNow(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!deps) return { ok: false, error: "Scheduler not initialized" };
  const job = getCronJob(id);
  if (!job) return { ok: false, error: `Job ${id} not found` };
  if (runningJobs.has(id))
    return { ok: false, error: "Job is already running" };

  await runScheduled(job);

  const after = getCronJob(id);
  if (after?.lastStatus === "error") {
    return { ok: false, error: after.lastError ?? "Job failed" };
  }
  return { ok: true };
}

// Track jobs that have already logged a bad-schedule warning to avoid log spam
// (isDue runs every 60s — a single bad job would flood the logs otherwise).
// Capped to prevent unbounded growth from ephemeral job IDs.
const warnedBadSchedule = new Set<string>();
const MAX_WARNED_SCHEDULES = 200;

function isDue(job: CronJob, now: Date): boolean {
  const nowMs = now.getTime();

  // Not-before gate (both modes): never fire before startAt.
  if (job.startAt !== undefined && nowMs < job.startAt) return false;

  // Backward clock guard (both modes): if the last run is in the future (NTP
  // jumped the clock back), wait for wall-clock to catch up rather than firing
  // a burst.
  if (job.lastRunAt !== undefined && job.lastRunAt > nowMs) return false;

  return isIntervalJob(job) ? isIntervalDue(job, nowMs) : isCronDue(job, now);
}

/**
 * Interval mode: due once `everyMs` has elapsed since the anchor (the last
 * run, else the job's start instant). A fresh job therefore first fires one
 * interval after it becomes eligible, not the instant it's created.
 */
function isIntervalDue(job: CronJob, nowMs: number): boolean {
  return nowMs - intervalAnchor(job) >= (job.everyMs as number);
}

/** Cron mode: due when the current minute matches a fire time. */
function isCronDue(job: CronJob, now: Date): boolean {
  if (!job.schedule) return false;
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
    await deps.sendMessage(numericChatId, job.content, job.chatId);
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
    `[System: CRON JOB "${job.name}" (schedule: ${describeSchedule(job)}). ` +
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
      job.chatId,
    );
  }
  return result;
}
