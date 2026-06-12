/**
 * Per-job health tracking for the cron scheduler — circuit breakers
 * with escalating cooldowns, built on the Gleam scheduler decision
 * core (src/native/scheduler-core.ts).
 *
 * A job that keeps throwing stops being dispatched every tick: after
 * `threshold` consecutive failures its breaker opens and runs are
 * blocked while it cools down. Cooldown length comes from the core's
 * deterministic backoff (escalating with each re-open, jittered per
 * job so herds de-correlate). After cooling down, one probe run is
 * allowed (half-open); success closes the breaker, failure re-opens it
 * with a longer cooldown.
 *
 * State is in-memory by design — a restart gives every job a clean
 * slate, which is the behavior you want after fixing whatever made the
 * job fail.
 */

import {
  backoffDelayMs,
  breakerAllowsRun,
  CLOSED_BREAKER,
  stepBreaker,
  type Breaker,
} from "../../native/scheduler-core.js";

export type JobHealthOptions = {
  /** Consecutive failures before the breaker opens. */
  threshold: number;
  /** Cooldown after the first open. */
  baseCooldownMs: number;
  /** Cooldown ceiling for repeatedly re-opening jobs. */
  maxCooldownMs: number;
};

type JobHealth = {
  breaker: Breaker;
  /** Times the breaker has opened since the last success — drives the
   * cooldown escalation (the core's breaker resets its own failure
   * count when it opens). */
  opens: number;
};

const health = new Map<string, JobHealth>();

function get(jobId: string): JobHealth {
  let h = health.get(jobId);
  if (!h) {
    h = { breaker: CLOSED_BREAKER, opens: 0 };
    health.set(jobId, h);
  }
  return h;
}

/** Deterministic per-job jitter seed (djb2 over the id). */
function jobSeed(jobId: string): number {
  let hash = 5381;
  for (let i = 0; i < jobId.length; i++) {
    hash = (hash * 33 + jobId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function cooldownMs(
  jobId: string,
  h: JobHealth,
  opts: JobHealthOptions,
): number {
  return backoffDelayMs(Math.max(1, h.opens), {
    baseMs: opts.baseCooldownMs,
    capMs: opts.maxCooldownMs,
    seed: jobSeed(jobId) + h.opens,
  });
}

/**
 * May this job run now? Also advances a cooled-down open breaker to
 * half-open (the tick event), so the answer flips to true exactly when
 * the cooldown elapses.
 */
export function jobAllowsRun(
  jobId: string,
  nowMs: number,
  opts: JobHealthOptions,
): boolean {
  const h = get(jobId);
  h.breaker = stepBreaker(h.breaker, "tick", nowMs, {
    threshold: opts.threshold,
    cooldownMs: cooldownMs(jobId, h, opts),
  });
  return breakerAllowsRun(h.breaker);
}

/** Record a successful run — closes the breaker, resets escalation. */
export function recordJobSuccess(
  jobId: string,
  nowMs: number,
  opts: JobHealthOptions,
): void {
  const h = get(jobId);
  h.breaker = stepBreaker(h.breaker, "success", nowMs, {
    threshold: opts.threshold,
    cooldownMs: cooldownMs(jobId, h, opts),
  });
  h.opens = 0;
}

/**
 * Record a failed run. Returns the cooldown in ms when this failure
 * opened the breaker (caller logs it), else null.
 */
export function recordJobFailure(
  jobId: string,
  nowMs: number,
  opts: JobHealthOptions,
): number | null {
  const h = get(jobId);
  const wasOpen = h.breaker.state === "open";
  h.breaker = stepBreaker(h.breaker, "failure", nowMs, {
    threshold: opts.threshold,
    cooldownMs: cooldownMs(jobId, h, opts),
  });
  if (h.breaker.state === "open" && !wasOpen) {
    h.opens += 1;
    return cooldownMs(jobId, h, opts);
  }
  return null;
}

/** Drop tracking for jobs that no longer exist (deleted cron jobs). */
export function pruneJobHealth(liveIds: ReadonlySet<string>): void {
  for (const id of health.keys()) {
    if (!liveIds.has(id)) health.delete(id);
  }
}

/** Test hook: forget everything. */
export function resetJobHealth(): void {
  health.clear();
}
