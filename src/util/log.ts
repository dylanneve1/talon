/**
 * Structured logging via pino — console + file output.
 *
 * Always runs at trace level (maximum verbosity) for debugging.
 * Logs to both:
 *   - stdout (pretty-printed for readability)
 *   - workspace/talon.log (JSON, append-only, for persistence)
 */

import pino from "pino";
import { existsSync, mkdirSync } from "node:fs";
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
  | "dispatcher";

const LOG_FILE = resolve(process.cwd(), "workspace", "talon.log");

// Ensure workspace dir exists for log file
const logDir = dirname(LOG_FILE);
if (!existsSync(logDir)) {
  try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
}

const logger = pino({
  level: "trace", // always max verbose for debugging
  transport: {
    targets: [
      // Pretty console output
      {
        target: "pino-pretty",
        level: "trace",
        options: {
          colorize: true,
          ignore: "pid,hostname",
          translateTime: "HH:MM:ss",
        },
      },
      // JSON file output (append-only)
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

/** The raw pino instance — for advanced use (child loggers, etc.) */
export { logger };
