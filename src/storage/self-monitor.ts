/**
 * Self-monitoring system — tracks bot performance metrics, error patterns,
 * tool usage frequency, and user satisfaction signals.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { resolve } from "node:path";
import { log, logError } from "../util/log.js";
import { dirs } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type PerformanceMetrics = {
  version: 1;

  // Response quality tracking
  responses: {
    total: number;
    withTools: number;        // used at least one tool
    withSend: number;         // actually sent a message (vs suppressed)
    suppressed: number;       // Claude responded but didn't use send
    errors: number;           // error responses
    avgTokensIn: number;
    avgTokensOut: number;
    avgResponseMs: number;
  };

  // Per-hour activity (24 slots)
  hourlyActivity: number[];

  // Error tracking
  recentErrors: Array<{
    timestamp: string;
    action: string;
    error: string;
  }>;

  // Tool usage frequency
  toolUsage: Record<string, number>;  // toolName -> call count

  // User satisfaction signals
  satisfaction: {
    reactionsReceived: number;
    repliesReceived: number;
    messagesSent: number;
    messagesIgnored: number;
  };

  lastUpdated: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const STORE_FILE = resolve(dirs.memory, "metrics.json");
const MAX_RECENT_ERRORS = 50;

// ── State ────────────────────────────────────────────────────────────────────

let metrics: PerformanceMetrics = createEmptyMetrics();

let dirty = false;

function createEmptyMetrics(): PerformanceMetrics {
  return {
    version: 1,
    responses: {
      total: 0,
      withTools: 0,
      withSend: 0,
      suppressed: 0,
      errors: 0,
      avgTokensIn: 0,
      avgTokensOut: 0,
      avgResponseMs: 0,
    },
    hourlyActivity: new Array(24).fill(0) as number[],
    recentErrors: [],
    toolUsage: {},
    satisfaction: {
      reactionsReceived: 0,
      repliesReceived: 0,
      messagesSent: 0,
      messagesIgnored: 0,
    },
    lastUpdated: new Date().toISOString(),
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

export function loadMetrics(): void {
  try {
    if (!existsSync(dirs.memory)) {
      mkdirSync(dirs.memory, { recursive: true });
    }
    if (existsSync(STORE_FILE)) {
      const raw = readFileSync(STORE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as PerformanceMetrics;
      if (parsed.version === 1) {
        metrics = parsed;
        log("self-monitor", `Loaded metrics: ${metrics.responses.total} total responses tracked`);
      }
    }
  } catch (err) {
    logError("self-monitor", "Failed to load metrics", err);
  }
}

export function flushMetrics(): void {
  if (!dirty) return;
  try {
    if (!existsSync(dirs.memory)) {
      mkdirSync(dirs.memory, { recursive: true });
    }
    const data = JSON.stringify(metrics, null, 2) + "\n";
    if (existsSync(STORE_FILE)) {
      try { writeFileAtomic.sync(STORE_FILE + ".bak", readFileSync(STORE_FILE)); } catch { /* best effort */ }
    }
    writeFileAtomic.sync(STORE_FILE, data);
    dirty = false;
  } catch (err) {
    logError("self-monitor", "Failed to flush metrics", err);
  }
}

registerCleanup(() => flushMetrics());

// ── Core functions ───────────────────────────────────────────────────────────

/**
 * Record a completed response from the AI backend.
 */
export function recordResponse(
  inputTokens: number,
  outputTokens: number,
  durationMs: number,
  usedSend: boolean,
  toolCount: number,
  error?: string | null,
): void {
  const r = metrics.responses;
  const prevTotal = r.total;

  r.total++;
  if (toolCount > 0) r.withTools++;
  if (usedSend) r.withSend++;
  if (!usedSend && !error) r.suppressed++;
  if (error) r.errors++;

  // Running average update
  r.avgTokensIn = prevTotal > 0
    ? (r.avgTokensIn * prevTotal + inputTokens) / r.total
    : inputTokens;
  r.avgTokensOut = prevTotal > 0
    ? (r.avgTokensOut * prevTotal + outputTokens) / r.total
    : outputTokens;
  r.avgResponseMs = prevTotal > 0
    ? (r.avgResponseMs * prevTotal + durationMs) / r.total
    : durationMs;

  // Track hourly activity
  const hour = new Date().getHours();
  metrics.hourlyActivity[hour]++;

  // Track errors
  if (error) {
    metrics.recentErrors.push({
      timestamp: new Date().toISOString(),
      action: "response",
      error,
    });
    if (metrics.recentErrors.length > MAX_RECENT_ERRORS) {
      metrics.recentErrors = metrics.recentErrors.slice(-MAX_RECENT_ERRORS);
    }
  }

  metrics.lastUpdated = new Date().toISOString();
  dirty = true;
}

/**
 * Record a tool use event.
 */
export function recordToolUse(toolName: string): void {
  metrics.toolUsage[toolName] = (metrics.toolUsage[toolName] ?? 0) + 1;
  metrics.lastUpdated = new Date().toISOString();
  dirty = true;
}

/**
 * Record a user satisfaction signal.
 */
export function recordSatisfactionSignal(type: "reaction" | "reply" | "sent" | "ignored"): void {
  switch (type) {
    case "reaction":
      metrics.satisfaction.reactionsReceived++;
      break;
    case "reply":
      metrics.satisfaction.repliesReceived++;
      break;
    case "sent":
      metrics.satisfaction.messagesSent++;
      break;
    case "ignored":
      metrics.satisfaction.messagesIgnored++;
      break;
  }
  metrics.lastUpdated = new Date().toISOString();
  dirty = true;
}

/**
 * Get current metrics.
 */
export function getMetrics(): PerformanceMetrics {
  return metrics;
}

/**
 * Generate a formatted performance report string.
 */
export function getPerformanceReport(): string {
  const r = metrics.responses;
  const s = metrics.satisfaction;

  const sendRate = r.total > 0 ? ((r.withSend / r.total) * 100).toFixed(1) : "0";
  const suppressRate = r.total > 0 ? ((r.suppressed / r.total) * 100).toFixed(1) : "0";
  const errorRate = r.total > 0 ? ((r.errors / r.total) * 100).toFixed(1) : "0";
  const toolRate = r.total > 0 ? ((r.withTools / r.total) * 100).toFixed(1) : "0";

  // Find peak hours
  const peakHours = metrics.hourlyActivity
    .map((count, hour) => ({ hour, count }))
    .filter((h) => h.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((h) => `${h.hour}:00 (${h.count})`)
    .join(", ");

  // Top 5 tools
  const topTools = Object.entries(metrics.toolUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `  ${name}: ${count}`)
    .join("\n");

  // Recent errors summary
  const recentErrorCount = metrics.recentErrors.filter((e) => {
    const age = Date.now() - new Date(e.timestamp).getTime();
    return age < 24 * 60 * 60 * 1000; // last 24h
  }).length;

  return [
    "=== Performance Report ===",
    "",
    `Total responses: ${r.total}`,
    `  Send rate: ${sendRate}% (${r.withSend} sent)`,
    `  Suppress rate: ${suppressRate}% (${r.suppressed} suppressed)`,
    `  Error rate: ${errorRate}% (${r.errors} errors)`,
    `  Tool usage rate: ${toolRate}% (${r.withTools} used tools)`,
    "",
    `Avg tokens: in=${Math.round(r.avgTokensIn)} out=${Math.round(r.avgTokensOut)}`,
    `Avg response time: ${Math.round(r.avgResponseMs)}ms`,
    "",
    `Peak hours: ${peakHours || "no data"}`,
    "",
    `Top tools:\n${topTools || "  no data"}`,
    "",
    `Satisfaction signals:`,
    `  Messages sent: ${s.messagesSent}`,
    `  Messages ignored: ${s.messagesIgnored}`,
    `  Reactions received: ${s.reactionsReceived}`,
    `  Replies received: ${s.repliesReceived}`,
    "",
    `Errors (last 24h): ${recentErrorCount}`,
    `Last updated: ${metrics.lastUpdated}`,
  ].join("\n");
}
