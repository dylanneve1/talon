/**
 * Structured logging via pino.
 *
 * Same API surface as before (log, logError, logWarn with component tags)
 * but now outputs structured JSON in production and pretty-prints in dev.
 * Set TALON_LOG_LEVEL=debug|info|warn|error (default: info).
 */

import pino from "pino";

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

const isDev = process.env.NODE_ENV !== "production";

const logger = pino({
  level: process.env.TALON_LOG_LEVEL || "info",
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname",
            translateTime: "HH:MM:ss",
          },
        },
      }
    : {}),
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
