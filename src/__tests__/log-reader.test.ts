/**
 * The daemon log reader and the surfaces built on it: parsing and
 * filters, walking rotated generations, the proc/log, proc/errors and
 * proc/alerts views.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../core/frontend-runtime/admin-notify.js", () => ({
  notifyAdmin: vi.fn(async () => {}),
}));

import {
  formatLogRecord,
  logGenerations,
  parseLogDuration,
  parseLogLine,
  readLogRecords,
  replayAlerts,
  type LogRecord,
} from "../core/daemon/log-reader.js";
import {
  createDiagnosticViews,
  renderAlertsView,
} from "../core/vfs/mounts/diagnostics.js";
import { createProcMount } from "../core/vfs/mounts/proc.js";
import { Vfs } from "../core/vfs/vfs.js";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const MIN = 60_000;

type Line = {
  level?: number;
  ago?: number;
  component?: string;
  msg: string;
  err?: string;
  stack?: string;
  turn?: string;
};

function jsonl(lines: Line[]): string {
  return (
    lines
      .map(({ level = 30, ago = 0, ...rest }) =>
        JSON.stringify({ level, time: NOW - ago, ...rest }),
      )
      .join("\n") + "\n"
  );
}

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "talon-logread-"));
  logPath = join(dir, "talon.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a file and pin its mtime relative to NOW: generations are ordered
 * by mtime and a `since` read skips files last written before the cutoff,
 * so a real-clock mtime would make these tests depend on the wall clock.
 */
function writeAt(path: string, lines: Line[], mtimeAgo: number): void {
  writeFileSync(path, jsonl(lines));
  const t = (NOW - mtimeAgo) / 1000;
  utimesSync(path, t, t);
}

const writeLog = (lines: Line[]): void => writeAt(logPath, lines, 0);

describe("parseLogLine", () => {
  it("maps pino fields and finds the turn id in a field or the message", () => {
    const rec = parseLogLine(
      JSON.stringify({
        level: 50,
        time: 5,
        component: "agent",
        msg: "turn.end chat=1 turn=t-42 outcome=error",
        err: "boom",
      }),
    );
    expect(rec).toEqual({
      ts: 5,
      level: "error",
      component: "agent",
      msg: "turn.end chat=1 turn=t-42 outcome=error",
      err: "boom",
      turn: "t-42",
    });
    expect(parseLogLine(JSON.stringify({ msg: "x", turn: 7 }))?.turn).toBe("7");
  });

  it("skips anything that is not a record", () => {
    expect(parseLogLine("plain text")).toBeNull();
    expect(parseLogLine('{"level":30,"ti')).toBeNull();
  });
});

describe("readLogRecords", () => {
  it("filters by level, component, since, grep and turn", () => {
    writeLog([
      { level: 30, component: "bot", msg: "hello" },
      { level: 40, component: "agent", msg: "slow turn=a1", ago: 2 * MIN },
      { level: 50, component: "agent", msg: "died", err: "ETIMEDOUT" },
      { level: 50, component: "telegram", msg: "poll", ago: 90 * MIN },
    ]);
    const read = (filter: object) =>
      readLogRecords(logPath, { limit: 50, filter }).map((r) => r.msg);
    expect(read({ minLevel: "warn" })).toEqual([
      "slow turn=a1",
      "died",
      "poll",
    ]);
    expect(read({ component: "agent" })).toEqual(["slow turn=a1", "died"]);
    expect(read({ since: NOW - 60 * MIN })).toEqual([
      "hello",
      "slow turn=a1",
      "died",
    ]);
    expect(read({ grep: "etimedout" })).toEqual(["died"]);
    expect(read({ turn: "a1" })).toEqual(["slow turn=a1"]);
  });

  it("walks back into rotated generations until the limit is met", () => {
    writeAt(`${logPath}.2`, [{ msg: "oldest" }], 30 * MIN);
    writeAt(`${logPath}.1`, [{ msg: "older" }], 20 * MIN);
    writeAt(`${logPath}.old`, [{ msg: "start-time" }], 25 * MIN);
    writeAt(logPath, [{ msg: "live" }], 0);
    expect(logGenerations(logPath)).toEqual([
      logPath,
      `${logPath}.1`,
      `${logPath}.old`,
      `${logPath}.2`,
    ]);
    const msgs = (limit: number, maxFiles?: number) =>
      readLogRecords(logPath, { limit, maxFiles }).map((r) => r.msg);
    expect(msgs(2)).toEqual(["older", "live"]);
    expect(msgs(10)).toEqual(["oldest", "start-time", "older", "live"]);
    expect(msgs(10, 2)).toEqual(["older", "live"]);
  });

  it("stops at a generation last written before `since`", () => {
    writeAt(`${logPath}.1`, [{ msg: "old", ago: 3 * 60 * MIN }], 3 * 60 * MIN);
    writeAt(logPath, [{ msg: "new" }], 0);
    const recs = readLogRecords(logPath, {
      limit: 10,
      filter: { since: NOW - 60 * MIN },
    });
    expect(recs.map((r) => r.msg)).toEqual(["new"]);
  });

  it("reads a missing log as empty", () => {
    expect(readLogRecords(logPath, { limit: 5 })).toEqual([]);
  });
});

describe("formatting and parsing helpers", () => {
  it("formats one human line with an appended turn and stack frames", () => {
    const rec: LogRecord = {
      ts: NOW,
      level: "error",
      component: "agent",
      msg: "turn failed",
      err: "boom",
      turn: "t9",
      stack: "Error: boom\n    at a (x.ts:1)\n    at b (y.ts:2)",
    };
    expect(formatLogRecord(rec, { stackLines: 1 })).toBe(
      "2026-09-25T12:00:00.000Z ERR agent      turn failed turn=t9 (boom)\n" +
        "    at a (x.ts:1)",
    );
  });

  it("parses durations, bare numbers as minutes", () => {
    expect(parseLogDuration("90s")).toBe(90_000);
    expect(parseLogDuration("15")).toBe(15 * MIN);
    expect(parseLogDuration("2h")).toBe(120 * MIN);
    expect(parseLogDuration("1d")).toBe(1440 * MIN);
    expect(parseLogDuration("soon")).toBeNull();
    expect(parseLogDuration("0m")).toBeNull();
  });

  it("replays alert lines to the set still open, reset by a daemon boot", () => {
    const rec = (component: string, msg: string, ts: number): LogRecord => ({
      ts,
      level: "warn",
      component,
      msg,
    });
    expect(
      replayAlerts([
        rec("alert", "[error] telegram.polling: down: ETIMEDOUT", 1),
        rec("alert", "[warn] disk.low: 3% free", 2),
        rec("alert", "[error] telegram.polling: still down", 3),
        rec("alert", "resolved disk.low after 5 min", 4),
      ]),
    ).toEqual([
      {
        key: "telegram.polling",
        severity: "error",
        message: "still down",
        since: 1,
      },
    ]);
    expect(
      replayAlerts([
        rec("alert", "[error] telegram.polling: down", 1),
        rec("bot", "Starting Talon...", 2),
      ]),
    ).toEqual([]);
  });
});

describe("proc diagnostic views", () => {
  const alerts = [
    {
      key: "heartbeat.failing",
      severity: "error" as const,
      message: "Heartbeat failed 3 times: ECONNRESET.",
      since: NOW - 12 * MIN,
    },
  ];

  function mountViews(): Vfs {
    const vfs = new Vfs();
    vfs.mount(
      "proc",
      createProcMount({
        tasks: () => [],
        events: () => [],
        views: createDiagnosticViews({
          logPath,
          alerts: () => alerts,
          now: () => NOW,
        }),
      }),
    );
    return vfs;
  }

  it("lists log, errors and alerts next to tasks and events", () => {
    writeLog([{ msg: "hi" }]);
    const listed = mountViews().list("talon://proc");
    expect(listed.ok && listed.value.map((e) => e.path)).toEqual([
      "proc/tasks",
      "proc/events",
      "proc/log",
      "proc/errors",
      "proc/alerts",
    ]);
  });

  it("proc/log is human lines, not JSON", () => {
    writeLog([
      { component: "bot", msg: "Ready in 1.2s" },
      { level: 40, component: "agent", msg: "slow" },
    ]);
    const read = mountViews().read("talon://proc/log");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const lines = read.value.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^# last 2 lines of .*talon\.log/);
    expect(lines[1]).toBe(
      "2026-09-25T12:00:00.000Z INF bot        Ready in 1.2s",
    );
    expect(lines[2]).toContain("WRN agent      slow");
    // stat and read agree (FUSE stats before it reads).
    const stat = mountViews().stat("talon://proc/log");
    expect(stat.ok && stat.value.size).toBe(Buffer.byteLength(read.value));
  });

  it("proc/errors keeps only warn and above, with stack frames", () => {
    writeLog([
      { component: "bot", msg: "noise" },
      {
        level: 50,
        component: "agent",
        msg: "turn.end turn=t1 outcome=error",
        err: "boom",
        stack: "Error: boom\n    at run (turn.ts:10)",
      },
    ]);
    const read = mountViews().read("talon://proc/errors");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).not.toContain("noise");
    expect(read.value).toContain(
      "ERR agent      turn.end turn=t1 outcome=error (boom)\n    at run (turn.ts:10)",
    );
  });

  it("proc/errors says so when the log is clean", () => {
    writeLog([{ msg: "all good" }]);
    const read = mountViews().read("talon://proc/errors");
    expect(read.ok && read.value).toMatch(/^# no warnings or errors/);
  });

  it("proc/alerts renders the live table", () => {
    const read = mountViews().read("talon://proc/alerts");
    expect(read.ok && read.value).toBe(
      "# 1 active alert(s)\n" +
        "[error] heartbeat.failing since 2026-09-25T11:48:00.000Z (12 min)\n" +
        "    Heartbeat failed 3 times: ECONNRESET.\n",
    );
    expect(renderAlertsView([], NOW)).toBe("# no active alerts\n");
  });
});
