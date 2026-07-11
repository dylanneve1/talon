/**
 * Watchdog -- tracks bot health and recent errors.
 * Monitors message processing activity and bridge HTTP server responsiveness.
 */

import { existsSync, mkdirSync } from "node:fs";
import { logWarn } from "./log.js";

// ── Message processing tracking ──────────────────────────────────────────────

let lastProcessedAt = Date.now();
let lastReceivedAt = 0;
let totalMessagesProcessed = 0;
const startTime = Date.now();

/**
 * Record that a message ARRIVED (enqueued for processing). Paired with
 * `recordMessageProcessed`, this is what lets the watchdog tell a wedged
 * message loop (work arrived, nothing finishing) apart from a bot that's
 * simply idle because nobody is talking to it. Idle is not a fault.
 */
export function recordMessageReceived(): void {
  lastReceivedAt = Date.now();
}

/** Record that a message was successfully processed. */
export function recordMessageProcessed(): void {
  lastProcessedAt = Date.now();
  totalMessagesProcessed++;
  resetStuckWarnBackoff();
}

/**
 * Test-only: reset the activity clocks to "just processed, nothing pending"
 * at the CURRENT Date.now(). Fake-timer suites need this because each test
 * restarts its fake clock at the real now, while timestamps recorded by an
 * earlier test may sit hours into that test's own fake future.
 */
export function resetWatchdogActivityForTests(): void {
  lastProcessedAt = Date.now();
  lastReceivedAt = 0;
  resetStuckWarnBackoff();
}

/**
 * How long the newest RECEIVED message has been waiting with no processing
 * completed after it. Zero when idle or keeping up.
 */
function stuckMs(now: number): number {
  if (lastReceivedAt === 0 || lastReceivedAt <= lastProcessedAt) return 0;
  return now - lastReceivedAt;
}

/** Get total messages processed since startup. */
export function getTotalMessagesProcessed(): number {
  return totalMessagesProcessed;
}

/** Get bot uptime in milliseconds. */
export function getUptimeMs(): number {
  return Date.now() - startTime;
}

// ── Error tracking ───────────────────────────────────────────────────────────

type ErrorRecord = {
  message: string;
  timestamp: number;
};

const recentErrors: ErrorRecord[] = [];
const MAX_ERRORS = 20;

/** Record an error for admin visibility. */
export function recordError(message: string): void {
  recentErrors.push({ message, timestamp: Date.now() });
  if (recentErrors.length > MAX_ERRORS) {
    recentErrors.splice(0, recentErrors.length - MAX_ERRORS);
  }
}

/** Get the last N errors. */
export function getRecentErrors(limit = 5): ErrorRecord[] {
  return recentErrors.slice(-limit);
}

// ── Inactivity monitoring ────────────────────────────────────────────────────

const STUCK_WARN_MS = 10 * 60 * 1000; // 10 minutes with unprocessed work
const STUCK_WARN_MAX_BACKOFF_MS = 60 * 60 * 1000;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let stuckWarnBackoffMs = STUCK_WARN_MS;
let nextStuckWarnAt = 0;

function resetStuckWarnBackoff(): void {
  stuckWarnBackoffMs = STUCK_WARN_MS;
  nextStuckWarnAt = 0;
}

export function startWatchdog(workspaceDir?: string): void {
  if (watchdogTimer) return;

  watchdogTimer = setInterval(() => {
    // Warn only when work is actually stuck — a message arrived and nothing
    // has finished processing since. A quiet chat used to trip this every
    // minute all night ("No messages processed for N minutes"), burying real
    // warnings in noise. Repeat warnings back off exponentially.
    const now = Date.now();
    const stuck = stuckMs(now);
    if (stuck > STUCK_WARN_MS && now >= nextStuckWarnAt) {
      const mins = Math.round(stuck / 60000);
      logWarn(
        "watchdog",
        `Message received ${mins} minutes ago is still unprocessed — the message loop may be wedged`,
      );
      nextStuckWarnAt = now + stuckWarnBackoffMs;
      stuckWarnBackoffMs = Math.min(
        stuckWarnBackoffMs * 2,
        STUCK_WARN_MAX_BACKOFF_MS,
      );
    }

    // Ensure workspace still exists (might have been deleted externally)
    if (workspaceDir && !existsSync(workspaceDir)) {
      logWarn("watchdog", "Workspace directory missing — recreating");
      try {
        mkdirSync(workspaceDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  }, 60_000); // Check every minute
}

export function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

// ── Health check ─────────────────────────────────────────────────────────────

export type HealthStatus = {
  healthy: boolean;
  uptimeMs: number;
  totalMessagesProcessed: number;
  lastProcessedAt: number;
  msSinceLastMessage: number;
  recentErrorCount: number;
};

/** Get current health status (exportable for external monitoring). */
export function getHealthStatus(): HealthStatus {
  const now = Date.now();
  const msSinceLastMessage = now - lastProcessedAt;
  return {
    // Unhealthy only when the message loop is actually stuck: a received
    // message has gone 30+ minutes with no processing completing after it.
    // Mere idleness (nobody texting the bot) used to flip this false and
    // show a red "unhealthy" row in the companion diagnostics overnight.
    healthy: stuckMs(now) < 30 * 60_000,
    uptimeMs: now - startTime,
    totalMessagesProcessed,
    lastProcessedAt,
    msSinceLastMessage,
    recentErrorCount: recentErrors.length,
  };
}
