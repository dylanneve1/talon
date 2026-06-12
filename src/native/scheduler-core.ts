/**
 * Typed boundary over the Gleam scheduler decision core.
 *
 * The policy logic (retry backoff, circuit breaker, missed-run
 * catch-up) lives in native/scheduler-core/src/scheduler_core.gleam —
 * a pure, exhaustively type-checked functional core compiled to plain
 * JavaScript (artifacts committed under src/native/, drift-guarded in
 * CI). No runtime dependency; the same Gleam source compiles to
 * Erlang unchanged if talon ever grows a multi-node BEAM orchestrator.
 *
 * Everything crossing this boundary is numbers (epoch ms) — this
 * wrapper restores the domain types.
 */

import {
  breaker_allows_run,
  breaker_step,
  catchup_runs,
  delay_ms,
  missed_count,
  next_due_ms,
} from "./scheduler-core/scheduler_core.mjs";

// ── Retry backoff ───────────────────────────────────────────────────────────

/**
 * Exponential backoff with deterministic ±25% jitter. `attempt` is
 * 1-based; pass a per-job seed (e.g. hash of job id + attempt) so
 * retries de-correlate across jobs.
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs: number; capMs: number; seed: number },
): number {
  return delay_ms(attempt, opts.baseMs, opts.capMs, opts.seed);
}

// ── Circuit breaker ─────────────────────────────────────────────────────────

export type BreakerState = "closed" | "open" | "half-open";

export type Breaker = {
  state: BreakerState;
  /** Consecutive failures while closed. */
  failures: number;
  /** When the breaker opened (epoch ms); 0 unless open. */
  sinceMs: number;
};

export const CLOSED_BREAKER: Breaker = {
  state: "closed",
  failures: 0,
  sinceMs: 0,
};

const STATE_CODE: Record<BreakerState, number> = {
  closed: 0,
  open: 1,
  "half-open": 2,
};
const CODE_STATE: BreakerState[] = ["closed", "open", "half-open"];
const EVENT_CODE = { success: 0, failure: 1, tick: 2 } as const;

export type BreakerEvent = keyof typeof EVENT_CODE;

/**
 * Advance the breaker state machine. `tick` events (no run finished)
 * promote a cooled-down open breaker to half-open.
 */
export function stepBreaker(
  breaker: Breaker,
  event: BreakerEvent,
  nowMs: number,
  opts: { threshold: number; cooldownMs: number },
): Breaker {
  const [state, failures, sinceMs] = breaker_step(
    STATE_CODE[breaker.state],
    breaker.failures,
    breaker.sinceMs,
    EVENT_CODE[event],
    nowMs,
    opts.threshold,
    opts.cooldownMs,
  );
  return { state: CODE_STATE[state], failures, sinceMs };
}

/** Open breakers block runs; half-open allows the single probe. */
export function breakerAllowsRun(breaker: Breaker): boolean {
  return breaker_allows_run(STATE_CODE[breaker.state]) === 1;
}

// ── Missed-run catch-up ─────────────────────────────────────────────────────

export type CatchupPolicy = "skip" | "once" | "all";

const POLICY_CODE: Record<CatchupPolicy, number> = { skip: 0, once: 1, all: 2 };

/** Fire times missed in (lastRun, now] for an interval job. */
export function missedRunCount(
  lastRunMs: number,
  everyMs: number,
  nowMs: number,
): number {
  return missed_count(lastRunMs, everyMs, nowMs);
}

/** Next due time strictly after now. */
export function nextDueMs(
  lastRunMs: number,
  everyMs: number,
  nowMs: number,
): number {
  return next_due_ms(lastRunMs, everyMs, nowMs);
}

/** How many catch-up runs to fire immediately under `policy`. */
export function catchupRunCount(
  missed: number,
  policy: CatchupPolicy,
  max: number,
): number {
  return catchup_runs(missed, POLICY_CODE[policy], max);
}
