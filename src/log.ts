/**
 * Centralized logging with consistent format: [HH:MM:SS] [component] message
 */

export type LogComponent =
  | "bot"
  | "bridge"
  | "agent"
  | "proactive"
  | "userbot"
  | "users"
  | "watchdog"
  | "workspace"
  | "shutdown"
  | "file"
  | "sessions"
  | "settings"
  | "commands";

function timestamp(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8); // HH:MM:SS
}

export function log(component: LogComponent, message: string): void {
  console.log(`[${timestamp()}] [${component}] ${message}`);
}

export function logError(
  component: LogComponent,
  message: string,
  err?: unknown,
): void {
  const errStr = err instanceof Error ? err.message : err ? String(err) : "";
  const suffix = errStr ? `: ${errStr}` : "";
  console.error(`[${timestamp()}] [${component}] ${message}${suffix}`);
}

export function logWarn(component: LogComponent, message: string): void {
  console.warn(`[${timestamp()}] [${component}] ${message}`);
}
