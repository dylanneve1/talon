/**
 * Structured logging via pino — console + file output.
 *
 * Always runs at trace level (maximum verbosity) for debugging.
 * Logs to both:
 *   - stdout (pretty-printed for readability)
 *   - workspace/talon.log (JSON, append-only, for persistence)
 */

import pino from "pino";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirs, files } from "./paths.js";
import {
  classify,
  errorMessage,
  safeStringify,
  TalonError,
} from "../core/errors.js";

export type LogComponent =
  | "bot"
  | "bridge"
  | "agent"
  | "pulse"
  | "userbot"
  | "users"
  | "watchdog"
  | "workspace"
  | "shutdown"
  | "file"
  | "history"
  | "sessions"
  | "settings"
  | "commands"
  | "cron"
  | "dream"
  | "heartbeat"
  | "dispatcher"
  | "gateway"
  | "plugin"
  | "teams"
  | "config"
  | "access"
  | "github"
  | "mempalace"
  | "playwright";

const LOG_FILE = files.log;
const SECRET_KEY_RE =
  /token|secret|password|passwd|authorization|cookie|api[_-]?key|session/i;
const MAX_LOG_FIELD_DEPTH = 5;

export type LogFields = Record<string, unknown>;

function reportInitFailure(message: string, err?: unknown): void {
  const detail = err === undefined ? "" : `: ${errorMessage(err)}`;
  process.stderr.write(`[log] ${message}${detail}\n`);
}

// Ensure .talon dir exists for log file
if (!existsSync(dirs.root)) {
  try {
    mkdirSync(dirs.root, { recursive: true });
  } catch (err) {
    reportInitFailure("Failed to create log directory", err);
  }
}

// Rotate log file on startup if it exceeds 10MB
const MAX_LOG_SIZE = 10 * 1024 * 1024;
try {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_SIZE) {
    const rotated = `${LOG_FILE}.old`;
    try {
      unlinkSync(rotated);
    } catch (err) {
      reportInitFailure("Failed to remove previous rotated log", err);
    }
    renameSync(LOG_FILE, rotated);
  }
} catch (err) {
  reportInitFailure("Failed to rotate log file", err);
}

// Suppress console output for terminal frontend (stdout belongs to the REPL)
let quiet = process.env.TALON_QUIET === "1";
if (!quiet) {
  try {
    const cfgPath = files.config;
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (cfg.frontend === "terminal") quiet = true;
    }
  } catch (err) {
    reportInitFailure("Failed to inspect config for quiet logging", err);
  }
}

const logger = pino({
  level: "trace",
  transport: {
    targets: [
      // Console output (disabled in quiet mode)
      ...(!quiet
        ? [
            {
              target: "pino-pretty",
              level: "trace" as const,
              options: {
                colorize: true,
                ignore: "pid,hostname",
                translateTime: "HH:MM:ss",
              },
            },
          ]
        : []),
      // JSON file output (always active)
      {
        target: "pino/file",
        level: "trace",
        options: {
          destination: LOG_FILE,
          mkdir: true,
        },
      },
    ],
  },
});

function redactValue(
  value: unknown,
  key = "",
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (key && SECRET_KEY_RE.test(key)) return "[redacted]";
  if (value === null || value === undefined) return value;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";
  if (depth >= MAX_LOG_FIELD_DEPTH) return "[max-depth]";
  if (value instanceof Error) return serializeError(value, depth + 1);
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, key, depth + 1, seen));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[childKey] = redactValue(childValue, childKey, depth + 1, seen);
    }
    return out;
  }
  return String(value);
}

function redactFields(fields?: LogFields): LogFields {
  if (!fields) return {};
  return redactValue(fields) as LogFields;
}

function readErrorString(err: unknown, key: string): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

function serializeError(err: unknown, depth = 0): LogFields {
  const classified = classify(err);
  const original = err instanceof Error ? err : undefined;
  const type =
    original?.name ??
    readErrorString(err, "name") ??
    (err === null ? "null" : typeof err);
  const stack = original?.stack;
  const code = classified.code ?? readErrorString(err, "code");

  const fields: LogFields = {
    type,
    message: errorMessage(err),
    reason: classified.reason,
    retryable: classified.retryable,
    ...(classified.status !== undefined ? { status: classified.status } : {}),
    ...(classified.retryAfterMs !== undefined
      ? { retryAfterMs: classified.retryAfterMs }
      : {}),
    ...(code ? { code } : {}),
    ...(stack ? { stack } : {}),
    ...(classified.metadata && Object.keys(classified.metadata).length > 0
      ? { metadata: classified.metadata }
      : {}),
  };

  const cause =
    original?.cause ??
    (err instanceof TalonError ? err.cause : undefined) ??
    (err && typeof err === "object"
      ? (err as Record<string, unknown>).cause
      : undefined);
  if (cause !== undefined && depth < 3) {
    fields.cause = serializeError(cause, depth + 1);
  }

  if (!original && typeof err !== "string") {
    const raw = safeStringify(err);
    if (raw !== undefined) fields.raw = raw;
  }

  return redactValue(fields) as LogFields;
}

function payload(component: LogComponent, fields?: LogFields): LogFields {
  return { component, ...redactFields(fields) };
}

export function log(
  component: LogComponent,
  message: string,
  fields?: LogFields,
): void {
  logger.info(payload(component, fields), message);
}

export function logError(
  component: LogComponent,
  message: string,
  err?: unknown,
  fields?: LogFields,
): void {
  logger.error(
    payload(component, {
      ...fields,
      ...(err !== undefined ? { err: serializeError(err) } : {}),
    }),
    message,
  );
}

export function logWarn(
  component: LogComponent,
  message: string,
  fields?: LogFields,
): void {
  logger.warn(payload(component, fields), message);
}

export function logDebug(
  component: LogComponent,
  message: string,
  fields?: LogFields,
): void {
  logger.debug(payload(component, fields), message);
}

// Expose logger to plugins running in the same process
(globalThis as Record<string, unknown>).__talonLog = log;
(globalThis as Record<string, unknown>).__talonLogError = logError;
(globalThis as Record<string, unknown>).__talonLogWarn = logWarn;
