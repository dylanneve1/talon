import { describe, it, expect, vi } from "vitest";

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
} = await import("../util/watchdog.js");

describe("watchdog", () => {
  describe("recordMessageProcessed", () => {
    it("increments counter", () => {
      const before = getTotalMessagesProcessed();
      recordMessageProcessed();
      recordMessageProcessed();
      recordMessageProcessed();
      expect(getTotalMessagesProcessed()).toBe(before + 3);
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
  });

  describe("getUptimeMs", () => {
    it("returns a positive number", () => {
      expect(getUptimeMs()).toBeGreaterThanOrEqual(0);
    });
  });
});
