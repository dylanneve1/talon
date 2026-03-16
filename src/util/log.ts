/**
 * Structured logging via pino — console + file output.
 *
 * Always runs at trace level (maximum verbosity) for debugging.
 * Logs to both:
 *   - stdout (pretty-printed for readability)
 *   - workspace/talon.log (JSON, append-only, for persistence)
 */

import pino from "pino";
import { existsSync, mkdirSync, statSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";

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
  | "sessions"
  | "settings"
  | "commands"
  | "cron"
  | "dispatcher"
  | "gateway";

const LOG_FILE = resolve(process.cwd(), "workspace", "talon.log");

// Ensure workspace dir exists for log file
const logDir = dirname(LOG_FILE);
if (!existsSync(logDir)) {
  try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
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

// TALON_QUIET=1 suppresses console output (used by terminal frontend)
const quiet = process.env.TALON_QUIET === "1";

const logger = pino({
  level: "trace",
  transport: {
    targets: [
      // Console output (disabled in quiet mode)
      ...(!quiet ? [{
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

