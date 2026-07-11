/**
 * Heartbeat scheduling + lifecycle — init, the cadence timer (Gleam
 * scheduler-core driven, restart/suspend-safe), the one-at-a-time run guard,
 * and the force/await/status public API.
 */

import { log, logError, logWarn } from "../../../util/log.js";
import {
  catchupRunCount,
  missedRunCount,
  nextDueMs,
} from "../../../native/scheduler-core.js";
import {
  hb,
  readHeartbeatState,
  writeHeartbeatState,
  type HeartbeatConfig,
  type HeartbeatState,
} from "./state.js";
import { HeartbeatTimeoutError, runHeartbeatAgent } from "./agent.js";

const STARTUP_DELAY_MS = 5 * 60 * 1000; // 5-minute delay before first run
const DUE_CHECK_INTERVAL_MS = 60 * 1000;

// Failure backoff. A failed run does NOT advance last_run, so without a
// backoff the every-minute due check re-fires the heartbeat 60×/hour against
// the same error (observed live: a session-limit night produced hundreds of
// identical failures a minute apart). Generic failures back off
// exponentially; session/rate-limit errors that state their own reset time
// wait for it instead of guessing.
const FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000;
const FAILURE_BACKOFF_MAX_MS = 60 * 60 * 1000;
/** Safety margin added past a parsed limit-reset time (clock skew, rollout). */
const LIMIT_RESET_BUFFER_MS = 2 * 60 * 1000;

/**
 * Parse the reset wall-clock time out of a session/rate-limit error message,
 * e.g. "You've hit your session limit · resets 12:20am (UTC)" or
 * "… resets 3pm (UTC)". Returns the epoch ms of the NEXT occurrence of that
 * UTC time after `now`, or null when the message doesn't carry one.
 */
export function parseSessionLimitResetMs(
  message: string,
  now: number,
): number | null {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i.exec(
    message,
  );
  if (!m) return null;
  const rawHour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (rawHour < 1 || rawHour > 12 || minute > 59) return null;
  let hour = rawHour % 12;
  if (m[3].toLowerCase() === "pm") hour += 12;
  const d = new Date(now);
  d.setUTCHours(hour, minute, 0, 0);
  let t = d.getTime();
  if (t <= now) t += 24 * 60 * 60 * 1000;
  return t;
}

/**
 * When to next allow an auto heartbeat after the Nth consecutive failure
 * (1-based). Limit errors with a stated reset time wait until then (+buffer);
 * everything else doubles from 5min up to a 60min cap.
 */
export function failureBackoffUntil(
  err: unknown,
  consecutiveFailures: number,
  now: number,
): number {
  const message = err instanceof Error ? err.message : String(err);
  if (/session limit|rate limit/i.test(message)) {
    const reset = parseSessionLimitResetMs(message, now);
    if (reset !== null) return reset + LIMIT_RESET_BUFFER_MS;
  }
  const exp = Math.min(
    FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    FAILURE_BACKOFF_MAX_MS,
  );
  return now + exp;
}

export function initHeartbeat(cfg: HeartbeatConfig): void {
  hb.config = cfg;
}

/**
 * Start the heartbeat timer. First run happens after a 5-minute startup delay,
 * then repeats at the configured interval.
 */
export function startHeartbeatTimer(intervalMinutes: number): void {
  if (hb.timer || hb.startupTimer) return; // already running or scheduled

  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    logWarn(
      "heartbeat",
      `Refusing to start heartbeat timer with invalid intervalMinutes: ${intervalMinutes}`,
    );
    return;
  }

  hb.intervalMinutesRef = intervalMinutes;
  const intervalMs = intervalMinutes * 60 * 1000;
  log(
    "heartbeat",
    `Starting heartbeat timer (every ${intervalMinutes}min, first due check in 5min)`,
  );

  hb.startupTimer = setTimeout(() => {
    hb.startupTimer = null;
    runIfDue(intervalMs, true);
    // Due checks every minute instead of one fixed setInterval(intervalMs):
    // the cadence is computed from persisted last_run via the Gleam scheduler
    // core, so it survives process restarts (a quick restart no longer resets
    // the phase or double-fires) and system suspends (any number of missed
    // fire times collapses into one catch-up run).
    hb.timer = setInterval(() => {
      runIfDue(intervalMs, false);
    }, DUE_CHECK_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

/**
 * Fire the heartbeat when its cadence says one (or more) runs are due. Decision
 * logic is the Gleam scheduler core: `missedRunCount` counts fire times in
 * (last_run, now], and the "once" catch-up policy collapses them into one run.
 */
function runIfDue(intervalMs: number, startup: boolean): void {
  if (hb.running) return;
  // Inside a failure backoff window — stay quiet instead of re-firing the
  // same error every due check. (Logged once, when the window was set.)
  if (Date.now() < hb.backoffUntil) return;
  const lastRun = readHeartbeatState()?.last_run ?? 0;
  if (lastRun <= 0) {
    // Never ran on this install — fire now to establish the cadence.
    executeHeartbeat("auto").catch(() => {});
    return;
  }
  const now = Date.now();
  const missed = missedRunCount(lastRun, intervalMs, now);
  if (catchupRunCount(missed, "once", 1) > 0) {
    executeHeartbeat("auto").catch(() => {});
  } else if (startup) {
    log(
      "heartbeat",
      `Cadence restored from state — next heartbeat due ${new Date(nextDueMs(lastRun, intervalMs, now)).toISOString()}`,
    );
  }
}

/**
 * Stop the heartbeat timer. Does not wait for in-flight runs. Use
 * awaitCurrentRun() after this to wait for a running heartbeat to finish.
 */
export function stopHeartbeatTimer(): void {
  if (hb.startupTimer) {
    clearTimeout(hb.startupTimer);
    hb.startupTimer = null;
  }
  if (hb.timer) {
    clearInterval(hb.timer);
    hb.timer = null;
    log("heartbeat", "Heartbeat timer stopped");
  }
}

/**
 * Wait for any in-flight heartbeat run to complete.
 * Call after stopHeartbeatTimer() during graceful shutdown.
 */
export async function awaitCurrentRun(timeoutMs = 10_000): Promise<void> {
  if (hb.currentRunPromise) {
    log("heartbeat", "Waiting for in-flight heartbeat to complete...");
    try {
      await Promise.race([
        hb.currentRunPromise,
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            logWarn(
              "heartbeat",
              "In-flight heartbeat did not finish within shutdown budget, proceeding",
            );
            resolve();
          }, timeoutMs);
          t.unref();
        }),
      ]);
    } catch {
      // Already logged in executeHeartbeat
    }
  }
}

/**
 * Force a heartbeat run immediately. Resolves when the heartbeat completes.
 * Throws if a heartbeat is already running.
 */
export async function forceHeartbeat(): Promise<void> {
  if (hb.running) throw new Error("Heartbeat already running");
  await executeHeartbeat("forced");
}

/** Get the current heartbeat status. */
export function getHeartbeatStatus(): HeartbeatState | null {
  return readHeartbeatState();
}

async function executeHeartbeat(trigger: "auto" | "forced"): Promise<void> {
  if (hb.running) return;

  const state = readHeartbeatState();
  const now = Date.now();
  const previousRunCount = state?.run_count ?? 0;
  const previousLastRun = state?.last_run ?? 0;

  hb.running = true;
  // Mark as running with last_started, but preserve last_run from previous run
  writeHeartbeatState({
    last_run: previousLastRun,
    last_started: now,
    status: "running",
    run_count: previousRunCount,
  });
  log(
    "heartbeat",
    `${trigger === "forced" ? "Force-triggering" : "Triggering"} heartbeat #${previousRunCount + 1} (last run: ${previousLastRun ? new Date(previousLastRun).toISOString() : "never"})`,
  );

  const run = (async () => {
    try {
      const heartbeatLogPath = await runHeartbeatAgent(
        previousLastRun,
        previousRunCount + 1,
      );
      // Only update last_run and increment run_count on success
      writeHeartbeatState({
        last_run: Date.now(),
        last_started: now,
        status: "idle",
        run_count: previousRunCount + 1,
      });
      hb.consecutiveFailures = 0;
      hb.backoffUntil = 0;
      log(
        "heartbeat",
        `Heartbeat #${previousRunCount + 1} complete (${trigger}), log: ${heartbeatLogPath}`,
      );
    } catch (err) {
      logError(
        "heartbeat",
        `Heartbeat #${previousRunCount + 1} failed (${trigger})`,
        err,
      );
      // Timeouts consume the full hour budget — advance state so the next
      // heartbeat sees a fresh window and a bumped run_count instead of
      // re-triggering against the same `last_run` forever. Non-timeout errors
      // retry from the previous successful run (no budget consumed).
      const isTimeout = err instanceof HeartbeatTimeoutError;
      writeHeartbeatState({
        last_run: isTimeout ? Date.now() : previousLastRun,
        last_started: now,
        status: "idle",
        run_count: isTimeout ? previousRunCount + 1 : previousRunCount,
      });
      // Timeouts advance last_run (budget consumed), so the cadence itself
      // spaces the next attempt. Every other failure retries against the same
      // last_run — back off so the due check doesn't hammer it every minute.
      if (!isTimeout) {
        hb.consecutiveFailures += 1;
        hb.backoffUntil = failureBackoffUntil(
          err,
          hb.consecutiveFailures,
          Date.now(),
        );
        logWarn(
          "heartbeat",
          `Backing off until ${new Date(hb.backoffUntil).toISOString()} ` +
            `after ${hb.consecutiveFailures} consecutive failure(s)`,
        );
      }
      if (trigger === "forced") throw err;
    } finally {
      hb.running = false;
      hb.currentRunPromise = null;
    }
  })();

  hb.currentRunPromise = run;
  await run;
}
