import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Spy on console methods before importing the module
const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

const { log, logError, logWarn } = await import("../util/log.js");

describe("log", () => {
  beforeEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
  });

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
  });

  describe("log(component, message)", () => {
    it("calls console.log with formatted string", () => {
      log("bot", "started successfully");
      expect(logSpy).toHaveBeenCalledOnce();
      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toContain("[bot]");
      expect(output).toContain("started successfully");
    });

    it("includes HH:MM:SS timestamp format", () => {
      log("agent", "test message");
      const output = logSpy.mock.calls[0][0] as string;
      // Timestamp format: [HH:MM:SS]
      expect(output).toMatch(/^\[\d{2}:\d{2}:\d{2}\]/);
    });

    it("uses the correct format: [HH:MM:SS] [component] message", () => {
      log("bridge", "connection open");
      const output = logSpy.mock.calls[0][0] as string;
      expect(output).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\] \[bridge\] connection open$/,
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
      ] as const;
      for (const component of components) {
        logSpy.mockClear();
        log(component, "test");
        expect(logSpy).toHaveBeenCalledOnce();
        const output = logSpy.mock.calls[0][0] as string;
        expect(output).toContain(`[${component}]`);
      }
    });
  });

  describe("logError(component, message, err?)", () => {
    it("calls console.error with formatted string", () => {
      logError("bot", "failed to start");
      expect(errorSpy).toHaveBeenCalledOnce();
      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).toContain("[bot]");
      expect(output).toContain("failed to start");
    });

    it("includes HH:MM:SS timestamp format", () => {
      logError("agent", "error occurred");
      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).toMatch(/^\[\d{2}:\d{2}:\d{2}\]/);
    });

    it("appends Error message when err is an Error", () => {
      logError("bridge", "request failed", new Error("timeout"));
      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).toContain("request failed");
      expect(output).toContain(": timeout");
    });

    it("appends stringified error when err is a string", () => {
      logError("sessions", "save failed", "disk full");
      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).toContain("save failed");
      expect(output).toContain(": disk full");
    });

    it("appends stringified error when err is a number", () => {
      logError("sessions", "exit code", 1);
      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).toContain(": 1");
    });

    it("omits suffix when err is undefined", () => {
      logError("settings", "something wrong");
      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\] \[settings\] something wrong$/,
      );
    });
  });

  describe("logWarn(component, message)", () => {
    it("calls console.warn with formatted string", () => {
      logWarn("watchdog", "inactivity detected");
      expect(warnSpy).toHaveBeenCalledOnce();
      const output = warnSpy.mock.calls[0][0] as string;
      expect(output).toContain("[watchdog]");
      expect(output).toContain("inactivity detected");
    });

    it("includes HH:MM:SS timestamp format", () => {
      logWarn("pulse", "slow response");
      const output = warnSpy.mock.calls[0][0] as string;
      expect(output).toMatch(/^\[\d{2}:\d{2}:\d{2}\]/);
    });

    it("uses the correct format: [HH:MM:SS] [component] message", () => {
      logWarn("cron", "job skipped");
      const output = warnSpy.mock.calls[0][0] as string;
      expect(output).toMatch(
        /^\[\d{2}:\d{2}:\d{2}\] \[cron\] job skipped$/,
      );
    });
  });
});
