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
 *   - Override with TALON_LOG_LEVEL env var
 *     (trace|debug|info|warn|error|fatal|silent)
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
import { toJsonSafe } from "./json-safe.js";

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
// When set, debug/trace messages are only emitted for matching components.
// Info and warn+ always pass through so operational and error output is never
// suppressed — this filter is purely for narrowing verbose debug output.

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

// Transport targets are intentionally open (level: "trace") so warn+ always
// reach the errors.log transport's own warn-level gate, regardless of the
// user-facing level set via setLogLevel. User-facing filtering is applied in
// the wrapper functions below: info/debug/trace wrappers gate on currentLevel,
// while warn/error/fatal wrappers always emit so the long-term error record
// is never diluted when someone temporarily raises the display level. The one
// exception is "silent", which short-circuits every wrapper so no output is
// produced at all — the user explicitly asked for silence.
const logger = pino({
  level: "trace",
  base: { pid: process.pid, v: 1 },
  transport: {
    targets: [
      // Console output (disabled in quiet mode or compiled binary)
      ...(!quiet && !isBunBinary
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
      // Full log file — accepts every level the wrappers let through
      {
        target: "pino/file",
        level: "trace" as const,
        options: {
          destination: LOG_FILE,
          mkdir: true,
        },
      },
      // Error-only log file — always warn+ for long-term retention
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

/**
 * Runtime level change — gates the info/debug/trace wrappers. Warn/error/fatal
 * always pass through so errors.log keeps a complete record (see logger
 * construction above). `logger.level` stays at "trace" so transport-level
 * filtering (e.g. errors.log's warn gate) remains the source of truth.
 */
export function setLogLevel(level: LogLevel): void {
  if (!VALID_LEVELS.includes(level)) {
    throw new Error(`Invalid log level: ${level}`);
  }
  currentLevel = level;
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
  // Only debug/trace are subject to the namespace filter; info and warn+ always
  // emit so operational signals and errors are never suppressed.
  if (LEVEL_WEIGHTS[level] >= LEVEL_WEIGHTS.info) return true;
  return isDebugEnabled(component);
}

function errMsg(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (err !== undefined) return String(err);
  return undefined;
}

export function log(component: LogComponent, message: string): void {
  if (!isLevelEnabled("info")) return;
  logger.info({ component }, message);
  pushRecent({ ts: Date.now(), level: "info", component, msg: message });
}

export function logError(
  component: LogComponent,
  message: string,
  err?: unknown,
): void {
  if (currentLevel === "silent") return;
  if (err instanceof Error) {
    logger.error({ component, err: err.message, stack: err.stack }, message);
  } else if (err !== undefined) {
    logger.error({ component, err: String(err) }, message);
  } else {
    logger.error({ component }, message);
  }
  pushRecent({
    ts: Date.now(),
    level: "error",
    component,
    msg: message,
    err: errMsg(err),
  });
}

export function logWarn(component: LogComponent, message: string): void {
  if (currentLevel === "silent") return;
  logger.warn({ component }, message);
  pushRecent({ ts: Date.now(), level: "warn", component, msg: message });
}

export function logDebug(component: LogComponent, message: string): void {
  if (!isLevelEnabled("debug")) return;
  if (!shouldEmit(component, "debug")) return;
  logger.debug({ component }, message);
  pushRecent({ ts: Date.now(), level: "debug", component, msg: message });
}

export function logTrace(component: LogComponent, message: string): void {
  if (!isLevelEnabled("trace")) return;
  if (!shouldEmit(component, "trace")) return;
  logger.trace({ component }, message);
  pushRecent({ ts: Date.now(), level: "trace", component, msg: message });
}

export function logFatal(
  component: LogComponent,
  message: string,
  err?: unknown,
): void {
  if (currentLevel === "silent") return;
  if (err instanceof Error) {
    logger.fatal({ component, err: err.message, stack: err.stack }, message);
  } else if (err !== undefined) {
    logger.fatal({ component, err: String(err) }, message);
  } else {
    logger.fatal({ component }, message);
  }
  pushRecent({
    ts: Date.now(),
    level: "fatal",
    component,
    msg: message,
    err: errMsg(err),
  });
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
  // Child-logger lines don't pass through the root wrap (that only taps the
  // root pino instance), so capture to the ring buffer directly here.
  const capture = (
    level: LogLevel,
    msg: string,
    err?: unknown,
    extra?: Record<string, unknown>,
  ): void => {
    pushRecent({
      ts: Date.now(),
      level,
      component: String(bindings.component),
      msg,
      // `err` can legitimately be any falsy non-undefined value (0, "", false)
      // that a plugin mistakenly passed as the error argument — capture those
      // as-is rather than dropping them silently.
      err:
        err instanceof Error
          ? err.message
          : err !== undefined
            ? String(err)
            : undefined,
      // Normalize extra into a JSON-safe, size-bounded form so a plugin can't
      // poison the ring with circular refs, BigInt, or megabyte payloads.
      extra: extra ? (toJsonSafe(extra) as Record<string, unknown>) : undefined,
    });
  };
  return {
    trace: (msg, extra) => {
      if (!isLevelEnabled("trace")) return;
      if (!shouldEmit(bindings.component, "trace")) return;
      pinoChild.trace(extra ?? {}, msg);
      capture("trace", msg, undefined, extra);
    },
    debug: (msg, extra) => {
      if (!isLevelEnabled("debug")) return;
      if (!shouldEmit(bindings.component, "debug")) return;
      pinoChild.debug(extra ?? {}, msg);
      capture("debug", msg, undefined, extra);
    },
    info: (msg, extra) => {
      if (!isLevelEnabled("info")) return;
      pinoChild.info(extra ?? {}, msg);
      capture("info", msg, undefined, extra);
    },
    warn: (msg, extra) => {
      if (currentLevel === "silent") return;
      pinoChild.warn(extra ?? {}, msg);
      capture("warn", msg, undefined, extra);
    },
    error: (msg, err, extra) => {
      if (currentLevel === "silent") return;
      const body: Record<string, unknown> = { ...(extra ?? {}) };
      if (err instanceof Error) {
        body.err = err.message;
        body.stack = err.stack;
      } else if (err !== undefined) {
        body.err = String(err);
      }
      pinoChild.error(body, msg);
      capture("error", msg, err, extra);
    },
    fatal: (msg, err, extra) => {
      if (currentLevel === "silent") return;
      const body: Record<string, unknown> = { ...(extra ?? {}) };
      if (err instanceof Error) {
        body.err = err.message;
        body.stack = err.stack;
      } else if (err !== undefined) {
        body.err = String(err);
      }
      pinoChild.fatal(body, msg);
      capture("fatal", msg, err, extra);
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
// Fixed-size circular buffer of the most recent log records. Exposed by
// /debug/logs so operators can peek at activity without tailing the file.
//
// Keyed on a write index + valid-count: inserts are O(1) with no Array#shift
// cost, which matters at default level "trace" where this is on every log line.

type LogRecord = {
  ts: number;
  level: LogLevel;
  component: string;
  msg: string;
  err?: string;
  extra?: Record<string, unknown>;
};

const RECENT_BUFFER_SIZE = 500;
const recentBuffer: (LogRecord | undefined)[] = new Array(RECENT_BUFFER_SIZE);
let recentBufferHead = 0; // next write index
let recentBufferSize = 0; // valid entries (≤ capacity)

function pushRecent(rec: LogRecord): void {
  recentBuffer[recentBufferHead] = rec;
  recentBufferHead = (recentBufferHead + 1) % RECENT_BUFFER_SIZE;
  if (recentBufferSize < RECENT_BUFFER_SIZE) recentBufferSize++;
}

/** Snapshot of the ring in oldest-to-newest order. */
function snapshotRecent(): LogRecord[] {
  if (recentBufferSize === 0) return [];
  if (recentBufferSize < RECENT_BUFFER_SIZE) {
    return recentBuffer.slice(0, recentBufferSize) as LogRecord[];
  }
  // Full ring — head points at the oldest entry as well as the next slot.
  return [
    ...(recentBuffer.slice(recentBufferHead) as LogRecord[]),
    ...(recentBuffer.slice(0, recentBufferHead) as LogRecord[]),
  ];
}

export function getRecentLogs(limit = 100, minLevel?: LogLevel): LogRecord[] {
  const ordered = snapshotRecent();
  const min = minLevel ? LEVEL_WEIGHTS[minLevel] : 0;
  const filtered =
    min === 0 ? ordered : ordered.filter((r) => LEVEL_WEIGHTS[r.level] >= min);
  return filtered.slice(-limit);
}

// Ring-buffer capture is done explicitly by the log*() helpers and by each
// childLogger method. Calling pino directly (outside those helpers) will skip
// the in-memory buffer — that's intentional, since pino targets a flat
// transport write path and avoiding a post-emit wrap keeps hot-path overhead
// at a single function call.

// ── Plugin access ─────────────────────────────────────────────────────────────

(globalThis as Record<string, unknown>).__talonLog = log;
(globalThis as Record<string, unknown>).__talonLogError = logError;
(globalThis as Record<string, unknown>).__talonLogWarn = logWarn;
(globalThis as Record<string, unknown>).__talonLogDebug = logDebug;
(globalThis as Record<string, unknown>).__talonChildLogger = childLogger;
