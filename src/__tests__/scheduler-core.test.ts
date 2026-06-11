/**
 * Gleam scheduler decision core — exercised through the committed JS
 * artifacts and the typed TS boundary (src/native/scheduler-core.ts).
 */

import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  breakerAllowsRun,
  catchupRunCount,
  CLOSED_BREAKER,
  missedRunCount,
  nextDueMs,
  stepBreaker,
  type Breaker,
} from "../native/scheduler-core.js";

const OPTS = { threshold: 3, cooldownMs: 30_000 };

describe("backoffDelayMs", () => {
  it("grows exponentially and respects the cap", () => {
    const base = { baseMs: 1000, capMs: 60_000, seed: 7 };
    const d1 = backoffDelayMs(1, base);
    const d4 = backoffDelayMs(4, base);
    const d20 = backoffDelayMs(20, base);
    expect(d1).toBeGreaterThanOrEqual(1000);
    expect(d4).toBeGreaterThan(d1);
    expect(d20).toBeLessThanOrEqual(60_000);
  });

  it("jitter stays within ±25% of the raw delay and within bounds", () => {
    for (let seed = 0; seed < 200; seed++) {
      const d = backoffDelayMs(3, { baseMs: 1000, capMs: 60_000, seed });
      // raw = 4000 → jittered ∈ [3000, 5000]
      expect(d).toBeGreaterThanOrEqual(3000);
      expect(d).toBeLessThanOrEqual(5000);
    }
  });

  it("is deterministic for the same seed", () => {
    const a = backoffDelayMs(5, { baseMs: 500, capMs: 60_000, seed: 1234 });
    const b = backoffDelayMs(5, { baseMs: 500, capMs: 60_000, seed: 1234 });
    expect(a).toBe(b);
  });
});

describe("circuit breaker", () => {
  it("opens after `threshold` consecutive failures", () => {
    let b: Breaker = CLOSED_BREAKER;
    b = stepBreaker(b, "failure", 1000, OPTS);
    b = stepBreaker(b, "failure", 2000, OPTS);
    expect(b.state).toBe("closed");
    expect(b.failures).toBe(2);
    b = stepBreaker(b, "failure", 3000, OPTS);
    expect(b.state).toBe("open");
    expect(b.sinceMs).toBe(3000);
    expect(breakerAllowsRun(b)).toBe(false);
  });

  it("success while closed resets the failure count", () => {
    let b: Breaker = CLOSED_BREAKER;
    b = stepBreaker(b, "failure", 1000, OPTS);
    b = stepBreaker(b, "success", 2000, OPTS);
    expect(b).toEqual(CLOSED_BREAKER);
  });

  it("half-opens after the cooldown, probes, and closes on success", () => {
    let b: Breaker = { state: "open", failures: 0, sinceMs: 1000 };
    b = stepBreaker(b, "tick", 20_000, OPTS);
    expect(b.state).toBe("open"); // still cooling down
    b = stepBreaker(b, "tick", 31_001, OPTS);
    expect(b.state).toBe("half-open");
    expect(breakerAllowsRun(b)).toBe(true);
    b = stepBreaker(b, "success", 32_000, OPTS);
    expect(b.state).toBe("closed");
  });

  it("re-opens with a fresh cooldown when the probe fails", () => {
    let b: Breaker = { state: "half-open", failures: 0, sinceMs: 0 };
    b = stepBreaker(b, "failure", 50_000, OPTS);
    expect(b.state).toBe("open");
    expect(b.sinceMs).toBe(50_000);
  });
});

describe("missed-run catch-up", () => {
  it("counts complete missed intervals", () => {
    expect(missedRunCount(0, 600_000, 3_600_000)).toBe(6);
    expect(missedRunCount(0, 600_000, 599_999)).toBe(0);
    expect(missedRunCount(1000, 0, 5000)).toBe(0); // degenerate interval
  });

  it("computes the next due time strictly after now", () => {
    expect(nextDueMs(0, 600_000, 3_600_000)).toBe(4_200_000);
    expect(nextDueMs(5000, 600_000, 1000)).toBe(605_000); // clock went backwards
  });

  it("applies catch-up policy", () => {
    expect(catchupRunCount(6, "skip", 10)).toBe(0);
    expect(catchupRunCount(6, "once", 10)).toBe(1);
    expect(catchupRunCount(0, "once", 10)).toBe(0);
    expect(catchupRunCount(6, "all", 4)).toBe(4);
    expect(catchupRunCount(2, "all", 4)).toBe(2);
  });
});
