/**
 * Bridge log parsing (frontend/native/logs.ts) — pino JSON tail →
 * wire LogEntry[], with level/component filtering and malformed-line
 * tolerance.
 */

import { describe, it, expect } from "vitest";
import { parseLogTail } from "../frontend/native/logs.js";
import { isLogLevel } from "../frontend/native/protocol.js";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

const SAMPLE = [
  line({ level: 30, time: 1000, component: "agent", msg: "turn started" }),
  line({ level: 40, time: 2000, component: "native", msg: "slow client" }),
  line({
    level: 50,
    time: 3000,
    component: "agent",
    msg: "SDK error",
    err: "You've hit your weekly limit",
    stack: "Error: ...\n  at x",
  }),
  line({ level: 20, time: 4000, component: "db", msg: "checkpoint" }),
].join("\n");

describe("parseLogTail", () => {
  it("parses pino lines into wire entries, newest last", () => {
    const entries = parseLogTail(SAMPLE, { limit: 10 });
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({
      ts: 1000,
      level: "info",
      component: "agent",
      msg: "turn started",
    });
    expect(entries[2].err).toBe("You've hit your weekly limit");
    expect(entries[2].stack).toContain("at x");
  });

  it("applies the limit from the tail (most recent kept)", () => {
    const entries = parseLogTail(SAMPLE, { limit: 2 });
    expect(entries.map((e) => e.ts)).toEqual([3000, 4000]);
  });

  it("filters by minimum level", () => {
    const entries = parseLogTail(SAMPLE, { limit: 10, minLevel: "warn" });
    expect(entries.map((e) => e.level)).toEqual(["warn", "error"]);
  });

  it("filters by component", () => {
    const entries = parseLogTail(SAMPLE, { limit: 10, component: "agent" });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.component === "agent")).toBe(true);
  });

  it("skips malformed lines (partial first line of a byte window)", () => {
    const raw = `okens":123}\n${SAMPLE}\nnot json at all\n{"broken":`;
    const entries = parseLogTail(raw, { limit: 10 });
    expect(entries).toHaveLength(4);
  });

  it("maps unknown numeric levels to info and missing fields to defaults", () => {
    const entries = parseLogTail(line({ level: 35, msg: "odd" }), {
      limit: 10,
    });
    expect(entries[0].level).toBe("info");
    expect(entries[0].ts).toBe(0);
    expect(entries[0].component).toBeUndefined();
  });
});

describe("isLogLevel", () => {
  it("accepts wire levels and rejects everything else", () => {
    expect(isLogLevel("warn")).toBe(true);
    expect(isLogLevel("fatal")).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
    expect(isLogLevel("")).toBe(false);
  });
});
