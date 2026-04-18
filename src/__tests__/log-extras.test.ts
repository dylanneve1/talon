import { describe, it, expect, vi } from "vitest";

// Pin env before importing log.ts — log.ts resolves initial level and debug
// namespaces at module-init time, so CI env bleeding would flake these tests.
process.env.TALON_LOG_LEVEL = "trace";
delete process.env.TALON_DEBUG;
delete process.env.TALON_QUIET;

const mockInfo = vi.fn();
const mockError = vi.fn();
const mockWarn = vi.fn();
const mockDebug = vi.fn();
const mockTrace = vi.fn();
const mockFatal = vi.fn();
const mockChild = vi.fn();

vi.mock("pino", () => ({
  default: () => {
    const logger = {
      level: "trace",
      info: mockInfo,
      error: mockError,
      warn: mockWarn,
      debug: mockDebug,
      trace: mockTrace,
      fatal: mockFatal,
      child: mockChild,
    };
    mockChild.mockReturnValue(logger);
    return logger;
  },
}));

const {
  newRequestId,
  childLogger,
  getLogLevel,
  setLogLevel,
  isLevelEnabled,
  isDebugEnabled,
  setDebugNamespaces,
  getRecentLogs,
  log,
  logError,
} = await import("../util/log.js");

describe("log extras", () => {
  it("newRequestId returns an 8-char hex string", () => {
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(newRequestId()).not.toBe(id);
  });

  it("childLogger creates a logger with bindings", () => {
    const child = childLogger({ component: "bot", reqId: "abc123" });
    expect(mockChild).toHaveBeenCalledWith(
      expect.objectContaining({ component: "bot", reqId: "abc123" }),
    );
    expect(typeof child.info).toBe("function");
    expect(typeof child.debug).toBe("function");
    expect(typeof child.error).toBe("function");
    expect(child.bindings().component).toBe("bot");
  });

  it("child.error preserves Error stack in the body", () => {
    const child = childLogger({ component: "bot" });
    const err = new Error("boom");
    child.error("failed", err);
    expect(mockError).toHaveBeenCalledWith(
      expect.objectContaining({ err: "boom", stack: expect.any(String) }),
      "failed",
    );
  });

  it("setLogLevel updates current level", () => {
    setLogLevel("warn");
    expect(getLogLevel()).toBe("warn");
    expect(isLevelEnabled("info")).toBe(false);
    expect(isLevelEnabled("warn")).toBe(true);
    expect(isLevelEnabled("error")).toBe(true);
    setLogLevel("trace");
  });

  it("setLogLevel rejects invalid levels", () => {
    expect(() => setLogLevel("boom" as never)).toThrow();
  });

  it("isDebugEnabled respects namespace filter", () => {
    setDebugNamespaces([]);
    expect(isDebugEnabled("gateway")).toBe(true);
    setDebugNamespaces(["gateway", "dispat*"]);
    expect(isDebugEnabled("gateway")).toBe(true);
    expect(isDebugEnabled("dispatcher")).toBe(true);
    expect(isDebugEnabled("teams")).toBe(false);
    setDebugNamespaces([]);
  });

  it("getRecentLogs captures info/warn/error records", () => {
    log("bot", "hello world");
    logError("bot", "kaboom", new Error("nope"));
    const records = getRecentLogs(10);
    const messages = records.map((r) => r.msg);
    expect(messages).toContain("hello world");
    expect(messages).toContain("kaboom");
    const err = records.find((r) => r.msg === "kaboom");
    expect(err?.level).toBe("error");
  });

  it("getRecentLogs respects minLevel filter", () => {
    log("bot", "info-only");
    logError("bot", "serious");
    const errs = getRecentLogs(10, "error");
    for (const r of errs) {
      expect(["error", "fatal"].includes(r.level)).toBe(true);
    }
  });

  it("child logger lines reach the ring buffer with component bindings", () => {
    const child = childLogger({ component: "dispatcher", reqId: "rid" });
    child.info("child-info");
    child.error("child-err", new Error("oops"));
    const records = getRecentLogs(50);
    const info = records.find(
      (r) => r.msg === "child-info" && r.level === "info",
    );
    const err = records.find(
      (r) => r.msg === "child-err" && r.level === "error",
    );
    expect(info?.component).toBe("dispatcher");
    expect(err?.component).toBe("dispatcher");
    expect(err?.err).toBe("oops");
  });

  it("captures falsy err values (0, '', false) instead of dropping them", () => {
    const child = childLogger({ component: "dispatcher" });
    child.error("zero-err", 0);
    child.error("empty-err", "");
    child.error("false-err", false);
    const records = getRecentLogs(50);
    expect(records.find((r) => r.msg === "zero-err")?.err).toBe("0");
    expect(records.find((r) => r.msg === "empty-err")?.err).toBe("");
    expect(records.find((r) => r.msg === "false-err")?.err).toBe("false");
  });

  it("normalizes circular extra so getRecentLogs is JSON-serializable", () => {
    const child = childLogger({ component: "dispatcher" });
    const cyclic: Record<string, unknown> = { name: "A" };
    cyclic.self = cyclic;
    child.info("cycle-info", cyclic);
    const rec = getRecentLogs(50).find((r) => r.msg === "cycle-info");
    expect(rec).toBeDefined();
    // The whole snapshot must round-trip through JSON without throwing.
    expect(() => JSON.stringify(rec)).not.toThrow();
    const safeExtra = rec?.extra as Record<string, unknown>;
    expect(safeExtra.name).toBe("A");
    expect(safeExtra.self).toBe("[circular]");
  });

  it("normalizes BigInt in extra so getRecentLogs is JSON-serializable", () => {
    const child = childLogger({ component: "dispatcher" });
    child.info("bigint-info", { n: 9999999999999999999n });
    const rec = getRecentLogs(50).find((r) => r.msg === "bigint-info");
    expect(() => JSON.stringify(rec)).not.toThrow();
    expect((rec?.extra as Record<string, unknown>).n).toMatch(/n$/);
  });
});
