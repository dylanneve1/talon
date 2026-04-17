/**
 * Structured logging via pino — console + file output.
 *
 * Targets:
 *   - stdout (pretty-printed for readability; suppressed in quiet/binary mode)
 *   - ~/.talon/talon.log      (JSON, all levels, rotated on startup at 10MB)
 *   - ~/.talon/errors.log     (JSON, warn+ only, rotated on startup at 10MB)
 *     — dedicated errors file that survives across restarts so subtle
 *       long-running errors can be tracked without info-log dilution.
 *
 * Level control:
 *   - Default level is "trace" (maximum verbosity)
 *   - Override with TALON_LOG_LEVEL env var (trace|debug|info|warn|error|fatal)
 *   - Namespace filter via TALON_DEBUG env var (comma list of components,
 *     wildcard * accepted; e.g. "gateway,dispatcher" or "tele*")
 *   - setLogLevel() flips the level at runtime (used by /debug/log-level)
 *
 * Correlation:
 *   - childLogger({ component, reqId, chatId, ... }) returns a pino child with
 *     bindings merged into every line. Use for per-request/per-chat logs.
 *   - newRequestId() generates an 8-char hex id suitable for correlation.
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
import { randomBytes } from "node:crypto";
import { dirs, files } from "./paths.js";

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
  | "playwright"
  | "trace"
  | "debug";

export type LogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal"
  | "silent";

const LOG_FILE = files.log;
const ERROR_LOG_FILE = files.errorLog;
const MAX_LOG_SIZE = 10 * 1024 * 1024;

// ── Directory / rotation setup ────────────────────────────────────────────────

if (!existsSync(dirs.root)) {
  try {
    mkdirSync(dirs.root, { recursive: true });
  } catch {
    /* ignore */
  }
}

function rotateIfOversized(path: string): void {
  try {
    if (existsSync(path) && statSync(path).size > MAX_LOG_SIZE) {
      const rotated = `${path}.old`;
      try {
        unlinkSync(rotated);
      } catch {
        /* ignore */
      }
      renameSync(path, rotated);
    }
  } catch {
    /* ignore */
  }
}

rotateIfOversized(LOG_FILE);
rotateIfOversized(ERROR_LOG_FILE);

// ── Level / quiet mode resolution ─────────────────────────────────────────────

const VALID_LEVELS: LogLevel[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
];

function resolveInitialLevel(): LogLevel {
  const env = (process.env.TALON_LOG_LEVEL ?? "").toLowerCase() as LogLevel;
  if (VALID_LEVELS.includes(env)) return env;
  return "trace";
}

// Detect if running as a bun compiled binary (pino-pretty can't be bundled).
const isBunBinary =
  (import.meta as { path?: string }).path?.startsWith("/$bunfs/") ?? false;

// Suppress console output for terminal frontend (stdout belongs to the REPL)
let quiet = process.env.TALON_QUIET === "1";
if (!quiet) {
  try {
    const cfgPath = files.config;
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (cfg.frontend === "terminal") quiet = true;
    }
  } catch {
    /* ignore */
  }
}

// ── Namespace filter (TALON_DEBUG) ────────────────────────────────────────────
// When set, only messages from matching components go to stdout and talon.log
// at debug/trace levels. warn+ always passes through so errors are never lost.

function parseNamespaces(raw: string | undefined): RegExp[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pat) => {
      const escaped = pat
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`);
    });
}

let debugNamespaces = parseNamespaces(process.env.TALON_DEBUG);

export function setDebugNamespaces(patterns: string[]): void {
  debugNamespaces = parseNamespaces(patterns.join(","));
}

export function isDebugEnabled(component: string): boolean {
  if (debugNamespaces.length === 0) return true;
  return debugNamespaces.some((re) => re.test(component));
}

// ── Pino construction ─────────────────────────────────────────────────────────

const initialLevel = resolveInitialLevel();

const logger = pino({
  level: "trace", // transport targets gate via their own level
  base: { pid: process.pid, v: 1 },
  transport: {
    targets: [
      // Console output (disabled in quiet mode or compiled binary)
      ...(!quiet && !isBunBinary
        ? [
            {
              target: "pino-pretty",
              level: initialLevel as string,
              options: {
                colorize: true,
                ignore: "pid,hostname",
                translateTime: "HH:MM:ss",
              },
            },
          ]
        : []),
      // Full log file (all levels)
      {
        target: "pino/file",
        level: initialLevel as string,
        options: {
          destination: LOG_FILE,
          mkdir: true,
        },
      },
      // Error-only log file — preserved long-term for subtle error tracking
      {
        target: "pino/file",
        level: "warn" as const,
        options: {
          destination: ERROR_LOG_FILE,
          mkdir: true,
        },
      },
    ],
  },
});

// Effective level — used by isLevelEnabled() when skipping expensive work
let currentLevel: LogLevel = initialLevel;

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Runtime level change — affects pino and skip-expensive-work guards. */
export function setLogLevel(level: LogLevel): void {
  if (!VALID_LEVELS.includes(level)) {
    throw new Error(`Invalid log level: ${level}`);
  }
  currentLevel = level;
  logger.level = level === "silent" ? "silent" : level;
}

export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_WEIGHTS[level] >= LEVEL_WEIGHTS[currentLevel];
}

// ── Correlation IDs ───────────────────────────────────────────────────────────

/** Generate an 8-character hex request id. */
export function newRequestId(): string {
  return randomBytes(4).toString("hex");
}

// ── Public API ────────────────────────────────────────────────────────────────

function shouldEmit(component: string, level: LogLevel): boolean {
  // Warn+ always emitted (important errors are never filtered away).
  if (LEVEL_WEIGHTS[level] >= LEVEL_WEIGHTS.warn) return true;
  return isDebugEnabled(component);
}

export function log(component: LogComponent, message: string): void {
  if (!shouldEmit(component, "info")) return;
  logger.info({ component }, message);
}

export function logError(
  component: LogComponent,
  message: string,
  err?: unknown,
): void {
  if (err instanceof Error) {
    logger.error({ component, err: err.message, stack: err.stack }, message);
  } else if (err !== undefined) {
    logger.error({ component, err: String(err) }, message);
  } else {
    logger.error({ component }, message);
  }
}

export function logWarn(component: LogComponent, message: string): void {
  logger.warn({ component }, message);
}

export function logDebug(component: LogComponent, message: string): void {
  if (!isLevelEnabled("debug")) return;
  if (!shouldEmit(component, "debug")) return;
  logger.debug({ component }, message);
}

export function logTrace(component: LogComponent, message: string): void {
  if (!isLevelEnabled("trace")) return;
  if (!shouldEmit(component, "trace")) return;
  logger.trace({ component }, message);
}

export function logFatal(
  component: LogComponent,
  message: string,
  err?: unknown,
): void {
  if (err instanceof Error) {
    logger.fatal({ component, err: err.message, stack: err.stack }, message);
  } else if (err !== undefined) {
    logger.fatal({ component, err: String(err) }, message);
  } else {
    logger.fatal({ component }, message);
  }
}

// ── Child loggers with fixed bindings ─────────────────────────────────────────

export type Bindings = {
  component: LogComponent;
  reqId?: string;
  chatId?: string | number;
  [key: string]: unknown;
};

export type ChildLogger = {
  trace: (msg: string, extra?: Record<string, unknown>) => void;
  debug: (msg: string, extra?: Record<string, unknown>) => void;
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, err?: unknown, extra?: Record<string, unknown>) => void;
  fatal: (msg: string, err?: unknown, extra?: Record<string, unknown>) => void;
  child: (extra: Record<string, unknown>) => ChildLogger;
  bindings: () => Bindings;
};

function buildChild(bindings: Bindings): ChildLogger {
  const pinoChild = logger.child(bindings);
  return {
    trace: (msg, extra) => {
      if (!isLevelEnabled("trace")) return;
      if (!shouldEmit(bindings.component, "trace")) return;
      pinoChild.trace(extra ?? {}, msg);
    },
    debug: (msg, extra) => {
      if (!isLevelEnabled("debug")) return;
      if (!shouldEmit(bindings.component, "debug")) return;
      pinoChild.debug(extra ?? {}, msg);
    },
    info: (msg, extra) => {
      if (!shouldEmit(bindings.component, "info")) return;
      pinoChild.info(extra ?? {}, msg);
    },
    warn: (msg, extra) => {
      pinoChild.warn(extra ?? {}, msg);
    },
    error: (msg, err, extra) => {
      const body: Record<string, unknown> = { ...(extra ?? {}) };
      if (err instanceof Error) {
        body.err = err.message;
        body.stack = err.stack;
      } else if (err !== undefined) {
        body.err = String(err);
      }
      pinoChild.error(body, msg);
    },
    fatal: (msg, err, extra) => {
      const body: Record<string, unknown> = { ...(extra ?? {}) };
      if (err instanceof Error) {
        body.err = err.message;
        body.stack = err.stack;
      } else if (err !== undefined) {
        body.err = String(err);
      }
      pinoChild.fatal(body, msg);
    },
    child: (extra) => buildChild({ ...bindings, ...extra } as Bindings),
    bindings: () => bindings,
  };
}

/**
 * Create a child logger with pre-bound fields. Every line emitted through it
 * is tagged with the bindings (component, reqId, chatId, etc.) — ideal for
 * per-request or per-chat context that you don't want to repeat at every call.
 */
export function childLogger(bindings: Bindings): ChildLogger {
  return buildChild(bindings);
}

// ── Recent in-memory buffer ───────────────────────────────────────────────────
// Small ring buffer of the most recent log records. Exposed by /debug/logs so
// operators can peek at activity without tailing the file.

type LogRecord = {
  ts: number;
  level: LogLevel;
  component: string;
  msg: string;
  err?: string;
  extra?: Record<string, unknown>;
};

const RECENT_BUFFER_SIZE = 500;
const recentBuffer: LogRecord[] = [];

function pushRecent(rec: LogRecord): void {
  recentBuffer.push(rec);
  if (recentBuffer.length > RECENT_BUFFER_SIZE) recentBuffer.shift();
}

export function getRecentLogs(limit = 100, minLevel?: LogLevel): LogRecord[] {
  const min = minLevel ? LEVEL_WEIGHTS[minLevel] : 0;
  const filtered =
    min === 0
      ? recentBuffer
      : recentBuffer.filter((r) => LEVEL_WEIGHTS[r.level] >= min);
  return filtered.slice(-limit);
}

// Tap pino so recent records stay accessible in-process.
const ORIG_INFO = logger.info.bind(logger);
const ORIG_WARN = logger.warn.bind(logger);
const ORIG_ERROR = logger.error.bind(logger);
const ORIG_DEBUG = logger.debug.bind(logger);
const ORIG_TRACE = logger.trace.bind(logger);
const ORIG_FATAL = logger.fatal.bind(logger);

type PinoCall = (obj: Record<string, unknown>, msg?: string) => void;

function wrap(orig: PinoCall, level: LogLevel): PinoCall {
  return (obj, msg) => {
    orig(obj, msg);
    const component =
      typeof obj === "object" && obj && "component" in obj
        ? String((obj as { component?: unknown }).component ?? "?")
        : "?";
    pushRecent({
      ts: Date.now(),
      level,
      component,
      msg: msg ?? "",
      err:
        typeof obj === "object" && obj && "err" in obj
          ? String((obj as { err?: unknown }).err)
          : undefined,
    });
  };
}

(logger as unknown as { info: PinoCall }).info = wrap(ORIG_INFO, "info");
(logger as unknown as { warn: PinoCall }).warn = wrap(ORIG_WARN, "warn");
(logger as unknown as { error: PinoCall }).error = wrap(ORIG_ERROR, "error");
(logger as unknown as { debug: PinoCall }).debug = wrap(ORIG_DEBUG, "debug");
(logger as unknown as { trace: PinoCall }).trace = wrap(ORIG_TRACE, "trace");
(logger as unknown as { fatal: PinoCall }).fatal = wrap(ORIG_FATAL, "fatal");

// ── Plugin access ─────────────────────────────────────────────────────────────

(globalThis as Record<string, unknown>).__talonLog = log;
(globalThis as Record<string, unknown>).__talonLogError = logError;
(globalThis as Record<string, unknown>).__talonLogWarn = logWarn;
(globalThis as Record<string, unknown>).__talonLogDebug = logDebug;
(globalThis as Record<string, unknown>).__talonChildLogger = childLogger;
