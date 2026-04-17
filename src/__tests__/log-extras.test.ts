import { describe, it, expect, vi } from "vitest";

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
});
