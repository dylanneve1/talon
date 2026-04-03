import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pino before importing log module
const mockInfo = vi.fn();
const mockError = vi.fn();
const mockWarn = vi.fn();
const mockDebug = vi.fn();

vi.mock("pino", () => ({
  default: () => ({
    info: mockInfo,
    error: mockError,
    warn: mockWarn,
    debug: mockDebug,
  }),
}));

const { log, logError, logWarn, logDebug } = await import("../util/log.js");

describe("log", () => {
  beforeEach(() => {
    mockInfo.mockClear();
    mockError.mockClear();
    mockWarn.mockClear();
    mockDebug.mockClear();
  });

  describe("log(component, message)", () => {
    it("calls pino.info with component and message", () => {
      log("bot", "started successfully");
      expect(mockInfo).toHaveBeenCalledOnce();
      expect(mockInfo).toHaveBeenCalledWith(
        { component: "bot" },
        "started successfully",
      );
    });

    it("works with all valid component types", () => {
      const components = [
        "bot",
        "bridge",
        "agent",
        "pulse",
        "userbot",
        "users",
        "watchdog",
        "workspace",
        "shutdown",
        "file",
        "sessions",
        "settings",
        "commands",
        "cron",
        "dispatcher",
      ] as const;
      for (const component of components) {
        mockInfo.mockClear();
        log(component, "test");
        expect(mockInfo).toHaveBeenCalledWith({ component }, "test");
      }
    });
  });

  describe("logError(component, message, err?)", () => {
    it("calls pino.error with component and message", () => {
      logError("bot", "failed to start");
      expect(mockError).toHaveBeenCalledOnce();
      expect(mockError).toHaveBeenCalledWith(
        { component: "bot" },
        "failed to start",
      );
    });

    it("includes Error message in context", () => {
      logError("bridge", "request failed", new Error("timeout"));
      expect(mockError).toHaveBeenCalledWith(
        { component: "bridge", err: "timeout" },
        "request failed",
      );
    });

    it("stringifies non-Error err values", () => {
      logError("sessions", "save failed", "disk full");
      expect(mockError).toHaveBeenCalledWith(
        { component: "sessions", err: "disk full" },
        "save failed",
      );
    });

    it("handles numeric err values", () => {
      logError("sessions", "exit code", 1);
      expect(mockError).toHaveBeenCalledWith(
        { component: "sessions", err: "1" },
        "exit code",
      );
    });

    it("omits err field when err is undefined", () => {
      logError("settings", "something wrong");
      expect(mockError).toHaveBeenCalledWith(
        { component: "settings" },
        "something wrong",
      );
    });
  });

  describe("logWarn(component, message)", () => {
    it("calls pino.warn with component and message", () => {
      logWarn("watchdog", "inactivity detected");
      expect(mockWarn).toHaveBeenCalledOnce();
      expect(mockWarn).toHaveBeenCalledWith(
        { component: "watchdog" },
        "inactivity detected",
      );
    });
  });

  describe("logDebug(component, message)", () => {
    it("calls pino.debug with component and message", () => {
      logDebug("agent", "processing query");
      expect(mockDebug).toHaveBeenCalledOnce();
      expect(mockDebug).toHaveBeenCalledWith(
        { component: "agent" },
        "processing query",
      );
    });
  });
});
