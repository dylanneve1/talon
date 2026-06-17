/**
 * Structured logging via pino — console + file output.
 *
 * Always runs at trace level (maximum verbosity) for debugging.
 * Logs to both:
 *   - stdout (pretty-printed for readability)
 *   - workspace/talon.log (JSON, append-only, for persistence)
 */

import pino from "pino";
import prettyStream from "pino-pretty";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  createWriteStream,
} from "node:fs";
import { dirs, files } from "./paths.js";

export type LogComponent =
  | "bot"
  | "bridge"
  | "db"
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
  | "triggers"
  | "scripts"
  | "skills"
  | "dream"
  | "heartbeat"
  | "dispatcher"
  | "gateway"
  | "plugin"
  | "teams"
  | "discord"
  | "native"
  | "config"
  | "access"
  | "github"
  | "mempalace"
  | "playwright"
  | "soul"
  | "backend-controller";

const LOG_FILE = files.log;

// Ensure .talon dir exists for log file
if (!existsSync(dirs.root)) {
  try {
    mkdirSync(dirs.root, { recursive: true });
  } catch {
    /* ignore */
  }
}

// Rotate log file on startup if it exceeds 10MB
const MAX_LOG_SIZE = 10 * 1024 * 1024;
try {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_SIZE) {
    const rotated = `${LOG_FILE}.old`;
    try {
      unlinkSync(rotated);
    } catch {
      /* ignore */
    }
    renameSync(LOG_FILE, rotated);
  }
} catch {
  /* ignore */
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
  } catch {
    /* ignore */
  }
}

// Under vitest, skip the file transport entirely. Its worker thread
// flushes asynchronously, so a log call near the end of a test races
// the suite's tmp-HOME cleanup (unhandled ENOENT — observed via
// codex-one-shot on macOS) — and suites that don't mock HOME would
// pollute the real ~/.talon/talon.log. Console output still flows for
// suites that don't mock this module.
const IS_VITEST = process.env.VITEST === "true";

// In-process streams (pino.multistream), NOT worker-thread transports.
// `transport: { targets }` spawns a thread-stream worker that resolves the
// target module ("pino-pretty", "pino/file") by name at runtime — which
// fails in a `bun build --compile` standalone binary (no node_modules on
// disk: "unable to determine transport target for pino-pretty"). Wiring
// the same destinations as direct streams keeps formatting identical and
// runs everywhere, with no worker.
const streams: pino.StreamEntry[] = [];

// Console output (disabled in quiet mode), pretty-printed.
if (!quiet) {
  streams.push({
    level: "trace",
    stream: prettyStream({
      colorize: true,
      ignore: "pid,hostname",
      translateTime: "HH:MM:ss",
    }),
  });
}

// JSON file output (always active outside test runs).
if (!IS_VITEST) {
  streams.push({
    level: "trace",
    stream: createWriteStream(LOG_FILE, { flags: "a" }),
  });
}

const logger =
  streams.length > 0
    ? pino({ level: "trace" }, pino.multistream(streams))
    : pino({ level: "silent" });

export function log(component: LogComponent, message: string): void {
  logger.info({ component }, message);
}

export function logError(
  component: LogComponent,
  message: string,
  err?: unknown,
): void {
  if (err instanceof Error) {
    // Capture both the concise message (for log consumers that look at `err`)
    // and the full stack (for diagnostics). pino-pretty renders the `stack`
    // field on its own line; JSON consumers can read either field.
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
  logger.debug({ component }, message);
}

// Expose logger to plugins running in the same process
(globalThis as Record<string, unknown>).__talonLog = log;
(globalThis as Record<string, unknown>).__talonLogError = logError;
(globalThis as Record<string, unknown>).__talonLogWarn = logWarn;
