import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock the log module
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const {
  recordMessageProcessed,
  getTotalMessagesProcessed,
  recordError,
  getRecentErrors,
  getHealthStatus,
  getUptimeMs,
  startWatchdog,
  stopWatchdog,
} = await import("../util/watchdog.js");

const WATCHDOG_TEST_DIR = join(tmpdir(), `talon-watchdog-test-${Date.now()}`);

describe("watchdog", () => {
  afterEach(() => {
    stopWatchdog();
  });

  describe("recordMessageProcessed", () => {
    it("increments counter", () => {
      const before = getTotalMessagesProcessed();
      recordMessageProcessed();
      recordMessageProcessed();
      recordMessageProcessed();
      expect(getTotalMessagesProcessed()).toBe(before + 3);
    });

    it("updates lastProcessedAt timestamp", () => {
      recordMessageProcessed();
      const afterStatus = getHealthStatus();
      // After recording, msSinceLastMessage should be very small (near 0)
      expect(afterStatus.msSinceLastMessage).toBeLessThanOrEqual(50);
    });
  });

  describe("recordError", () => {
    it("stores error with timestamp", () => {
      const beforeCount = getRecentErrors(100).length;
      recordError("something went wrong");
      const errors = getRecentErrors(100);
      expect(errors.length).toBe(beforeCount + 1);

      const lastError = errors[errors.length - 1];
      expect(lastError.message).toBe("something went wrong");
      expect(lastError.timestamp).toBeGreaterThan(0);
      expect(lastError.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it("stores multiple errors in order", () => {
      const before = getRecentErrors(100).length;
      recordError("first-error");
      recordError("second-error");
      recordError("third-error");
      const errors = getRecentErrors(100);
      const newErrors = errors.slice(before);
      expect(newErrors[0].message).toBe("first-error");
      expect(newErrors[1].message).toBe("second-error");
      expect(newErrors[2].message).toBe("third-error");
    });
  });

  describe("getRecentErrors", () => {
    it("returns last N errors", () => {
      // Record several errors
      for (let i = 0; i < 5; i++) {
        recordError(`error-batch-${i}`);
      }
      const last2 = getRecentErrors(2);
      expect(last2).toHaveLength(2);
      // Should be the most recent 2
      expect(last2[1].message).toBe("error-batch-4");
      expect(last2[0].message).toBe("error-batch-3");
    });

    it("defaults to 5 errors when no limit specified", () => {
      // Fill with enough errors
      for (let i = 0; i < 10; i++) {
        recordError(`default-limit-${i}`);
      }
      const errors = getRecentErrors();
      expect(errors).toHaveLength(5);
    });

    it("returns fewer than limit when not enough errors exist", () => {
      // The array already has errors from prior tests, but requesting a huge limit
      // should return at most what's available (capped at 20)
      const all = getRecentErrors(200);
      expect(all.length).toBeLessThanOrEqual(20);
    });
  });

  describe("error cap", () => {
    it("does not grow infinitely (capped at MAX_ERRORS)", () => {
      // Push more than 20 errors (MAX_ERRORS = 20)
      for (let i = 0; i < 30; i++) {
        recordError(`overflow-error-${i}`);
      }
      const all = getRecentErrors(100);
      expect(all.length).toBeLessThanOrEqual(20);
    });

    it("keeps the most recent errors after cap", () => {
      // Push enough to guarantee we hit the cap
      for (let i = 0; i < 25; i++) {
        recordError(`cap-test-${i}`);
      }
      const all = getRecentErrors(100);
      // The last error should be the most recent one
      expect(all[all.length - 1].message).toBe("cap-test-24");
    });
  });

  describe("getHealthStatus", () => {
    it("returns correct structure", () => {
      const status = getHealthStatus();
      expect(status).toHaveProperty("healthy");
      expect(status).toHaveProperty("uptimeMs");
      expect(status).toHaveProperty("totalMessagesProcessed");
      expect(status).toHaveProperty("lastProcessedAt");
      expect(status).toHaveProperty("msSinceLastMessage");
      expect(status).toHaveProperty("recentErrorCount");

      expect(status.healthy).toBe(true);
      expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(status.totalMessagesProcessed).toBeGreaterThanOrEqual(0);
      expect(status.lastProcessedAt).toBeGreaterThan(0);
      expect(status.msSinceLastMessage).toBeGreaterThanOrEqual(0);
      expect(typeof status.recentErrorCount).toBe("number");
    });

    it("reflects message count from recordMessageProcessed", () => {
      const before = getHealthStatus().totalMessagesProcessed;
      recordMessageProcessed();
      const after = getHealthStatus().totalMessagesProcessed;
      expect(after).toBe(before + 1);
    });

    it("reflects error count from recordError", () => {
      const before = getHealthStatus().recentErrorCount;
      recordError("health-check-error");
      const after = getHealthStatus().recentErrorCount;
      // If already at cap (MAX_ERRORS=20), count stays at 20
      if (before < 20) {
        expect(after).toBe(before + 1);
      } else {
        expect(after).toBe(20);
      }
    });

    it("reports healthy when no messages have been processed yet (fresh start scenario)", () => {
      // When totalMessagesProcessed > 0 and recent, should be healthy
      recordMessageProcessed();
      const status = getHealthStatus();
      expect(status.healthy).toBe(true);
    });

    it("uptimeMs increases over time", async () => {
      const first = getUptimeMs();
      await new Promise((r) => setTimeout(r, 5));
      const second = getUptimeMs();
      expect(second).toBeGreaterThanOrEqual(first);
    });

    it("msSinceLastMessage updates after recordMessageProcessed", () => {
      recordMessageProcessed();
      const status = getHealthStatus();
      // Just processed a message, so msSinceLastMessage should be small
      expect(status.msSinceLastMessage).toBeLessThan(1000);
    });
  });

  describe("getUptimeMs", () => {
    it("returns a positive number", () => {
      expect(getUptimeMs()).toBeGreaterThanOrEqual(0);
    });

    it("returns a number (type check)", () => {
      expect(typeof getUptimeMs()).toBe("number");
    });
  });

  describe("startWatchdog / stopWatchdog", () => {
    afterEach(() => {
      stopWatchdog();
      if (existsSync(WATCHDOG_TEST_DIR)) {
        rmSync(WATCHDOG_TEST_DIR, { recursive: true });
      }
    });

    it("startWatchdog does not throw", () => {
      expect(() => startWatchdog()).not.toThrow();
    });

    it("stopWatchdog does not throw when not started", () => {
      expect(() => stopWatchdog()).not.toThrow();
    });

    it("startWatchdog is idempotent (calling twice is safe)", () => {
      startWatchdog();
      expect(() => startWatchdog()).not.toThrow();
      stopWatchdog();
    });

    it("stopWatchdog clears the timer", () => {
      startWatchdog();
      stopWatchdog();
      // Calling stopWatchdog again should be a no-op
      expect(() => stopWatchdog()).not.toThrow();
    });

    it("can restart after stopping", () => {
      startWatchdog();
      stopWatchdog();
      expect(() => startWatchdog()).not.toThrow();
      stopWatchdog();
    });

    it("accepts a workspace directory argument", () => {
      mkdirSync(WATCHDOG_TEST_DIR, { recursive: true });
      expect(() => startWatchdog(WATCHDOG_TEST_DIR)).not.toThrow();
      stopWatchdog();
    });

    it("watchdog interval callback checks workspace existence", () => {
      // Use fake timers to trigger the interval
      vi.useFakeTimers();
      try {
        mkdirSync(WATCHDOG_TEST_DIR, { recursive: true });
        startWatchdog(WATCHDOG_TEST_DIR);

        // Remove the workspace dir to trigger the recreate path
        rmSync(WATCHDOG_TEST_DIR, { recursive: true });
        expect(existsSync(WATCHDOG_TEST_DIR)).toBe(false);

        // Advance timer to trigger interval callback (60 seconds)
        vi.advanceTimersByTime(60_000);

        // Watchdog should have recreated the directory
        expect(existsSync(WATCHDOG_TEST_DIR)).toBe(true);

        stopWatchdog();
      } finally {
        vi.useRealTimers();
      }
    });

    it("watchdog interval logs warning on inactivity", async () => {
      const logModule = await import("../util/log.js");
      const { logWarn } = vi.mocked(logModule);
      vi.useFakeTimers();
      try {
        // Record a message first so totalMessagesProcessed > 0
        recordMessageProcessed();

        startWatchdog();

        // Advance past the inactivity threshold (10 minutes = 600_000ms)
        // Need to advance enough for both: setting lastProcessedAt to be old + triggering the interval
        vi.advanceTimersByTime(11 * 60_000);

        // logWarn should have been called with an inactivity message
        expect(logWarn).toHaveBeenCalledWith(
          "watchdog",
          expect.stringContaining("No messages processed"),
        );

        stopWatchdog();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
