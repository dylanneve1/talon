/**
 * Structured progress logging for plugin self-heal flows.
 *
 * Each lifecycle is a sequence of numbered steps, each one either ok / fail /
 * skipped with a timing attached. The goal is that a user scanning talon.log
 * can pinpoint exactly which step failed and how long each step took —
 * without reading subprocess stderr interleaved with Talon's other log
 * output.
 *
 * This module is log-sink agnostic: pass in a `LogSink` so tests can capture
 * events in memory and production wires in `util/log.ts`.
 */

import {
  log as defaultLog,
  logError,
  logWarn,
  type LogComponent,
} from "../../util/log.js";

export type LogLevel = "info" | "warn" | "error";

export type LogSink = (
  level: LogLevel,
  component: LogComponent,
  message: string,
) => void;

/** Adapter: route sink events to Talon's structured log helpers. */
export const defaultLogSink: LogSink = (level, component, message) => {
  switch (level) {
    case "warn":
      logWarn(component, message);
      return;
    case "error":
      logError(component, message);
      return;
    default:
      defaultLog(component, message);
  }
};

export type StepStatus = "ok" | "fail" | "skipped";

export type StepRecord = Readonly<{
  index: number; // 1-based for humans
  label: string;
  status: StepStatus;
  elapsedMs: number;
  detail?: string;
}>;

export interface StepTracker {
  /** Complete the step successfully. Optional detail appears inline. */
  ok(detail?: string): StepRecord;
  /** Complete the step as failed. `message` is the short error summary. */
  fail(message: string): StepRecord;
  /** Skip the step — no-op, not a failure. Include a reason. */
  skip(reason: string): StepRecord;
  /** Stream a progress line (subprocess output, etc) nested under the step. */
  stream(line: string): void;
}

export interface ProgressLogger {
  /** Start a new step. Numbered automatically (1, 2, 3, …). */
  step(label: string): StepTracker;
  /** Emit a free-form info line attached to the plugin component. */
  info(message: string): void;
  /** Emit a warning line attached to the plugin component. */
  warn(message: string): void;
  /** Emit an error line attached to the plugin component. */
  error(message: string): void;
  /** Read back every step recorded so far (for summaries / tests). */
  records(): readonly StepRecord[];
  /** Total milliseconds across all steps (ok / fail, excluding skipped). */
  totalElapsedMs(): number;
}

export interface CreateLoggerOptions {
  component: LogComponent;
  sink?: LogSink;
  /** Override `Date.now()` for deterministic tests. */
  now?: () => number;
}

export function createProgressLogger(
  opts: CreateLoggerOptions,
): ProgressLogger {
  const { component } = opts;
  const sink = opts.sink ?? defaultLogSink;
  const now = opts.now ?? Date.now;

  const records: StepRecord[] = [];
  let stepCounter = 0;

  const logger: ProgressLogger = {
    step(label: string): StepTracker {
      stepCounter += 1;
      const index = stepCounter;
      const start = now();
      sink("info", component, `▸ [${index}] ${label}`);

      const finalize = (
        status: StepStatus,
        message: string | undefined,
        level: LogLevel,
      ): StepRecord => {
        const elapsedMs = now() - start;
        const record: StepRecord = {
          index,
          label,
          status,
          elapsedMs,
          detail: message,
        };
        records.push(record);
        const timing = formatElapsed(elapsedMs);
        const glyph = status === "ok" ? "✓" : status === "fail" ? "✗" : "–";
        const suffix = message ? ` — ${message}` : "";
        sink(
          level,
          component,
          `  ${glyph} [${index}] ${label} (${timing})${suffix}`,
        );
        return record;
      };

      return {
        ok(detail) {
          return finalize("ok", detail, "info");
        },
        fail(message) {
          return finalize("fail", message, "error");
        },
        skip(reason) {
          return finalize("skipped", reason, "info");
        },
        stream(line) {
          const trimmed = line.replace(/\s+$/u, "");
          if (trimmed.length === 0) return;
          sink("info", component, `    ${trimmed}`);
        },
      };
    },

    info(message) {
      sink("info", component, message);
    },
    warn(message) {
      sink("warn", component, message);
    },
    error(message) {
      sink("error", component, message);
    },

    records() {
      return records;
    },

    totalElapsedMs() {
      return records
        .filter((r) => r.status !== "skipped")
        .reduce((acc, r) => acc + r.elapsedMs, 0);
    },
  };

  return logger;
}

/** Render a ms duration as a compact "Ns"/"N.Ns" string. Cap at one decimal. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 600) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds - minutes * 60);
  return `${minutes}m${remainder.toString().padStart(2, "0")}s`;
}
