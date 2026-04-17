/**
 * Debug snapshot — aggregates runtime state from across Talon subsystems into
 * a single JSON dump suitable for /debug/state and the `talon debug state`
 * CLI command. Kept free of cyclic imports by using dynamic imports where
 * needed.
 */

import {
  getTotalMessagesProcessed,
  getUptimeMs,
  getHealthStatus,
  getRecentErrors,
} from "./watchdog.js";
import { getMetrics } from "./metrics.js";
import { getRecentSpans, type SpanRecord } from "./trace.js";
import { getRecentLogs, getLogLevel, type LogLevel } from "./log.js";
import { getActiveCount } from "../core/dispatcher.js";
import { getActiveSessionCount } from "../storage/sessions.js";

export type DebugSnapshot = {
  ts: string;
  process: {
    pid: number;
    uptimeSec: number;
    node: string;
    memMb: number;
    rssMb: number;
    platform: string;
  };
  bot: {
    uptimeMs: number;
    totalMessagesProcessed: number;
    recentErrorCount: number;
    healthy: boolean;
  };
  dispatcher: {
    activeQueries: number;
  };
  sessions: {
    active: number;
  };
  logs: {
    level: LogLevel;
    recent: Array<Record<string, unknown>>;
    recentErrors: Array<{ message: string; timestamp: number }>;
  };
  metrics: ReturnType<typeof getMetrics>;
  spans: {
    recent: SpanRecord[];
  };
};

/** Build a best-effort snapshot. Individual sections swallow errors so that
 * a single broken source never blocks the whole report. */
export function buildDebugSnapshot(
  opts: { logLimit?: number; spanLimit?: number } = {},
): DebugSnapshot {
  const mem = process.memoryUsage();
  const health = safe(() => getHealthStatus(), {
    healthy: true,
    uptimeMs: 0,
    totalMessagesProcessed: 0,
    lastProcessedAt: 0,
    msSinceLastMessage: 0,
    recentErrorCount: 0,
  });

  return {
    ts: new Date().toISOString(),
    process: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      node: process.versions.node,
      memMb: Math.round(mem.heapUsed / 1024 / 1024),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      platform: process.platform,
    },
    bot: {
      uptimeMs: safe(() => getUptimeMs(), 0),
      totalMessagesProcessed: safe(() => getTotalMessagesProcessed(), 0),
      recentErrorCount: health.recentErrorCount,
      healthy: health.healthy,
    },
    dispatcher: {
      activeQueries: safe(() => getActiveCount(), 0),
    },
    sessions: {
      active: safe(() => getActiveSessionCount(), 0),
    },
    logs: {
      level: safe(() => getLogLevel(), "info" as LogLevel),
      recent: safe(
        () => getRecentLogs(opts.logLimit ?? 50) as Array<Record<string, unknown>>,
        [],
      ),
      recentErrors: safe(() => getRecentErrors(20), []),
    },
    metrics: safe(() => getMetrics(), { counters: {}, histograms: {} }),
    spans: {
      recent: safe(() => getRecentSpans(opts.spanLimit ?? 100), []),
    },
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
