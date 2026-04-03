/**
 * Structured logging via pino — console + file output.
 *
 * Always runs at trace level (maximum verbosity) for debugging.
 * Logs to both:
 *   - stdout (pretty-printed for readability)
 *   - workspace/talon.log (JSON, append-only, for persistence)
 */

import pino from "pino";
import { existsSync, readFileSync, mkdirSync, statSync, renameSync, unlinkSync } from "node:fs";
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
  | "dispatcher"
  | "gateway"
  | "plugin"
  | "teams"
  | "config"
  | "userbot-frontend";

const LOG_FILE = files.log;

// Ensure .talon dir exists for log file
if (!existsSync(dirs.root)) {
  try { mkdirSync(dirs.root, { recursive: true }); } catch { /* ignore */ }
}

// Rotate log file on startup if it exceeds 10MB
const MAX_LOG_SIZE = 10 * 1024 * 1024;
try {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_SIZE) {
    const rotated = `${LOG_FILE}.old`;
    try { unlinkSync(rotated); } catch { /* ignore */ }
    renameSync(LOG_FILE, rotated);
  }
} catch { /* ignore */ }

// Detect if running as a bun compiled binary (pino-pretty can't be bundled).
// import.meta.path is Bun-specific — undefined in Node.js/Vitest, so guard with ?.
const isBunBinary = (import.meta as { path?: string }).path?.startsWith("/$bunfs/") ?? false;

// Suppress console output for terminal frontend (stdout belongs to the REPL)
let quiet = process.env.TALON_QUIET === "1";
if (!quiet) {
  try {
    const cfgPath = files.config;
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (cfg.frontend === "terminal") quiet = true;
    }
  } catch { /* ignore */ }
}

const logger = pino({
  level: "trace",
  transport: {
    targets: [
      // Console output (disabled in quiet mode or compiled binary)
      ...(!quiet && !isBunBinary ? [{
        target: "pino-pretty",
        level: "trace" as const,
        options: {
          colorize: true,
          ignore: "pid,hostname",
          translateTime: "HH:MM:ss",
        },
      }] : []),
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

export function log(component: LogComponent, message: string): void {
  logger.info({ component }, message);
}

export function logError(
  component: LogComponent,
  message: string,
  err?: unknown,
): void {
  if (err instanceof Error) {
    logger.error({ component, err: err.message }, message);
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

