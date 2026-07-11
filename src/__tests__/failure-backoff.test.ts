/**
 * Failure backoff for background agents — pure-helper coverage.
 * Behavioral coverage rides the consumers' suites (heartbeat.test.ts,
 * dream.test.ts).
 */

import { describe, it, expect } from "vitest";
import {
  parseSessionLimitResetMs,
  failureBackoffUntil,
  FailureBackoff,
} from "../core/background/failure-backoff.js";

describe("parseSessionLimitResetMs", () => {
  const NOW = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z

  it("parses an am time with minutes", () => {
    expect(
      parseSessionLimitResetMs(
        "You've hit your session limit · resets 12:20am (UTC)",
        NOW,
      ),
    ).toBe(Date.UTC(2026, 0, 1, 0, 20, 0));
  });

  it("parses a bare pm hour", () => {
    expect(parseSessionLimitResetMs("resets 3pm (UTC)", NOW)).toBe(
      Date.UTC(2026, 0, 1, 15, 0, 0),
    );
  });

  it("rolls to the next day when the time already passed", () => {
    const now = Date.UTC(2026, 0, 1, 18, 0, 0);
    expect(parseSessionLimitResetMs("resets 12:20am (UTC)", now)).toBe(
      Date.UTC(2026, 0, 2, 0, 20, 0),
    );
  });

  it("handles 12pm as noon", () => {
    expect(parseSessionLimitResetMs("resets 12pm (UTC)", NOW)).toBe(
      Date.UTC(2026, 0, 1, 12, 0, 0),
    );
  });

  it("returns null when no reset time is present", () => {
    expect(parseSessionLimitResetMs("something went wrong", NOW)).toBeNull();
    expect(parseSessionLimitResetMs("resets soon", NOW)).toBeNull();
  });

  it("rejects out-of-range fields", () => {
    expect(parseSessionLimitResetMs("resets 13pm (UTC)", NOW)).toBeNull();
    expect(parseSessionLimitResetMs("resets 3:75pm (UTC)", NOW)).toBeNull();
  });
});

describe("failureBackoffUntil", () => {
  const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

  it("waits for a stated session-limit reset (+buffer) instead of guessing", () => {
    const err = new Error(
      "Claude Code returned an error result: You've hit your session limit · resets 12:20am (UTC)",
    );
    expect(failureBackoffUntil(err, 1, NOW)).toBe(
      Date.UTC(2026, 0, 1, 0, 22, 0), // 12:20am + 2min buffer
    );
  });

  it("doubles from 5min and caps at 60min for generic failures", () => {
    const err = new Error("backend exploded");
    expect(failureBackoffUntil(err, 1, NOW)).toBe(NOW + 5 * 60 * 1000);
    expect(failureBackoffUntil(err, 2, NOW)).toBe(NOW + 10 * 60 * 1000);
    expect(failureBackoffUntil(err, 3, NOW)).toBe(NOW + 20 * 60 * 1000);
    expect(failureBackoffUntil(err, 10, NOW)).toBe(NOW + 60 * 60 * 1000);
  });

  it("falls back to exponential when a limit error has no parsable time", () => {
    const err = new Error("You've hit your session limit · resets later");
    expect(failureBackoffUntil(err, 1, NOW)).toBe(NOW + 5 * 60 * 1000);
  });
});

describe("FailureBackoff", () => {
  const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

  it("is inactive until a failure arms it", () => {
    const b = new FailureBackoff();
    expect(b.active(NOW)).toBe(false);
    const until = b.fail(new Error("boom"), NOW);
    expect(until).toBe(NOW + 5 * 60 * 1000);
    expect(b.active(NOW)).toBe(true);
    expect(b.active(until - 1)).toBe(true);
    expect(b.active(until)).toBe(false);
  });

  it("escalates on consecutive failures and resets on success", () => {
    const b = new FailureBackoff();
    b.fail(new Error("boom"), NOW);
    const second = b.fail(new Error("boom"), NOW);
    expect(second).toBe(NOW + 10 * 60 * 1000);
    expect(b.failures).toBe(2);
    b.succeed();
    expect(b.failures).toBe(0);
    expect(b.active(NOW)).toBe(false);
    expect(b.fail(new Error("boom"), NOW)).toBe(NOW + 5 * 60 * 1000);
  });
});
