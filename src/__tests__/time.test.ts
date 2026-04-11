import { describe, it, expect, afterEach } from "vitest";
import {
  setTimezone,
  getTimezone,
  formatSmartTimestamp,
  formatFullDatetime,
  formatRelativeAge,
} from "../util/time.js";

describe("time utilities", () => {
  describe("setTimezone / getTimezone", () => {
    afterEach(() => setTimezone(undefined));

    it("returns system timezone when none configured", () => {
      setTimezone(undefined);
      expect(getTimezone()).toBeTruthy();
      expect(typeof getTimezone()).toBe("string");
    });

    it("returns configured timezone", () => {
      setTimezone("America/New_York");
      expect(getTimezone()).toBe("America/New_York");
    });

    it("resets to system timezone when set to undefined", () => {
      setTimezone("Europe/Warsaw");
      setTimezone(undefined);
      expect(getTimezone()).not.toBe("Europe/Warsaw");
    });
  });

  describe("formatSmartTimestamp", () => {
    afterEach(() => setTimezone(undefined));

    it("returns HH:MM for today", () => {
      const now = Date.now();
      const result = formatSmartTimestamp(now);
      expect(result).toMatch(/^\d{2}:\d{2}$/);
    });

    it("returns 'Yesterday HH:MM' for yesterday", () => {
      const yesterday = Date.now() - 86_400_000;
      const result = formatSmartTimestamp(yesterday);
      expect(result).toMatch(/^Yesterday \d{2}:\d{2}$/);
    });

    it("returns 'Month Day HH:MM' for a date earlier this year", () => {
      // Use a date 60 days ago (safe to assume still same year in most cases)
      const sixtyDaysAgo = Date.now() - 60 * 86_400_000;
      const date = new Date(sixtyDaysAgo);
      const currentYear = new Date().getFullYear();
      // Only test if still in same year
      if (date.getFullYear() === currentYear) {
        const result = formatSmartTimestamp(sixtyDaysAgo);
        // Format: "Apr 2 14:32"
        expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
      }
    });

    it("returns 'YYYY-MM-DD HH:MM' for a date in a different year", () => {
      // A timestamp from 2020 — safely in a past year
      const oldDate = new Date("2020-06-15T12:00:00Z").getTime();
      const result = formatSmartTimestamp(oldDate);
      expect(result).toMatch(/^2020-\d{2}-\d{2} \d{2}:\d{2}$/);
    });
  });

  describe("formatFullDatetime", () => {
    afterEach(() => setTimezone(undefined));

    it("returns a non-empty string", () => {
      expect(formatFullDatetime().length).toBeGreaterThan(10);
    });

    it("includes timezone name", () => {
      setTimezone("UTC");
      expect(formatFullDatetime()).toContain("UTC");
    });

    it("includes a weekday abbreviation", () => {
      const result = formatFullDatetime();
      expect(result).toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
    });

    it("includes human-readable date in DD/MM/YYYY format", () => {
      setTimezone("UTC");
      const result = formatFullDatetime();
      expect(result).toMatch(/\[\d{2}\/\d{2}\/\d{4}\]$/);
    });

    it("has consistent dates between ISO and human formats", () => {
      setTimezone("UTC");
      const result = formatFullDatetime();
      const isoMatch = result.match(/^(\d{4})-(\d{2})-(\d{2})/);
      const humanMatch = result.match(/\[(\d{2})\/(\d{2})\/(\d{4})\]$/);
      expect(isoMatch).toBeTruthy();
      expect(humanMatch).toBeTruthy();
      // ISO: YYYY-MM-DD, Human: DD/MM/YYYY — should be the same date
      expect(isoMatch![1]).toBe(humanMatch![3]); // year
      expect(isoMatch![2]).toBe(humanMatch![2]); // month
      expect(isoMatch![3]).toBe(humanMatch![1]); // day
    });
  });

  describe("formatRelativeAge", () => {
    it("returns 'just now' for timestamps within the last minute", () => {
      expect(formatRelativeAge(Date.now() - 30_000)).toBe("just now");
      expect(formatRelativeAge(Date.now())).toBe("just now");
    });

    it("returns minutes ago for timestamps within the last hour", () => {
      expect(formatRelativeAge(Date.now() - 5 * 60_000)).toBe("5m ago");
      expect(formatRelativeAge(Date.now() - 59 * 60_000)).toBe("59m ago");
    });

    it("returns hours ago for timestamps within the last day", () => {
      expect(formatRelativeAge(Date.now() - 3 * 3_600_000)).toBe("3h ago");
      expect(formatRelativeAge(Date.now() - 23 * 3_600_000)).toBe("23h ago");
    });

    it("returns days ago for old timestamps", () => {
      expect(formatRelativeAge(Date.now() - 2 * 86_400_000)).toBe("2d ago");
      expect(formatRelativeAge(Date.now() - 30 * 86_400_000)).toBe("30d ago");
    });
  });
});
