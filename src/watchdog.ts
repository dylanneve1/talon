/**
 * Watchdog -- tracks bot health and recent errors.
 * Monitors message processing activity and bridge HTTP server responsiveness.
 */

import { logWarn } from "./log.js";

// ── Message processing tracking ──────────────────────────────────────────────

let lastProcessedAt = Date.now();
let totalMessagesProcessed = 0;
const startTime = Date.now();

/** Record that a message was successfully processed. */
export function recordMessageProcessed(): void {
  lastProcessedAt = Date.now();
  totalMessagesProcessed++;
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

const INACTIVITY_WARN_MS = 10 * 60 * 1000; // 10 minutes
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

export function startWatchdog(): void {
  if (watchdogTimer) return;

  watchdogTimer = setInterval(() => {
    const elapsed = Date.now() - lastProcessedAt;
    if (totalMessagesProcessed > 0 && elapsed > INACTIVITY_WARN_MS) {
      const mins = Math.round(elapsed / 60000);
      logWarn("watchdog", `No messages processed for ${mins} minutes`);
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
  return {
    healthy: true, // Bot is running if this returns
    uptimeMs: now - startTime,
    totalMessagesProcessed,
    lastProcessedAt,
    msSinceLastMessage: now - lastProcessedAt,
    recentErrorCount: recentErrors.length,
  };
}
