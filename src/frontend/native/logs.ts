/**
 * Daemon log access for the client bridge.
 *
 * Parses the pino JSON log file (`~/.talon/talon.log`, one object per
 * line — see util/log.ts) into the wire `LogEntry` shape so clients can
 * render the daemon's log without shipping a pino parser of their own.
 * Pure functions over a raw tail string; file I/O stays with the caller.
 */

import { tailFile } from "../../util/tail-file.js";
import type { LogEntry, LogLevel } from "./protocol.js";

/** pino numeric levels → wire level names. */
const PINO_LEVELS: Record<number, LogLevel> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export type LogQuery = {
  /** Max entries returned (most recent last). */
  limit: number;
  /** Minimum severity — entries below it are dropped. */
  minLevel?: LogLevel;
  /** Exact component match (e.g. "agent", "native"). */
  component?: string;
};

/**
 * Parse a raw tail of the pino log file into wire entries, newest last.
 * Malformed lines (partial first line of the byte window, rotation
 * artifacts) are skipped rather than failing the whole request.
 */
export function parseLogTail(raw: string, query: LogQuery): LogEntry[] {
  const minRank = query.minLevel ? LEVEL_RANK[query.minLevel] : 0;
  const entries: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const levelNum = typeof obj.level === "number" ? obj.level : 30;
    if (levelNum < minRank) continue;
    const component =
      typeof obj.component === "string" ? obj.component : undefined;
    if (query.component && component !== query.component) continue;
    entries.push({
      ts: typeof obj.time === "number" ? obj.time : 0,
      level: PINO_LEVELS[levelNum] ?? "info",
      ...(component ? { component } : {}),
      msg: typeof obj.msg === "string" ? obj.msg : "",
      ...(typeof obj.err === "string" ? { err: obj.err } : {}),
      ...(typeof obj.stack === "string" ? { stack: obj.stack } : {}),
    });
  }
  return entries.slice(-query.limit);
}

/**
 * Read + parse the newest `query.limit` entries from `path`. The byte
 * window scales with the request so filtered queries (level/component)
 * still have material to fill from, capped so a hostile `lines` value
 * can't make the daemon slurp the whole file.
 */
export function readLogEntries(path: string, query: LogQuery): LogEntry[] {
  const maxBytes = Math.min(
    2 * 1024 * 1024,
    Math.max(64 * 1024, query.limit * 2048),
  );
  let raw: string;
  try {
    // Line budget is generous vs `limit` so level-filtered queries can
    // still return `limit` matches from a mostly-info tail.
    raw = tailFile(path, query.limit * 20, maxBytes);
  } catch {
    return [];
  }
  return parseLogTail(raw, query);
}
