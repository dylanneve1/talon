import { describe, it, expect, beforeEach } from "vitest";
import { incrementCounter, getMetrics, resetMetrics } from "../util/metrics.js";

describe("metrics", () => {
  beforeEach(() => resetMetrics());

  it("increments counters", () => {
    incrementCounter("test.count");
    incrementCounter("test.count");
    incrementCounter("test.count", 3);
    expect(getMetrics().counters["test.count"]).toBe(5);
  });

  it("resets all metrics", () => {
    incrementCounter("x");
    resetMetrics();
    const m = getMetrics();
    expect(Object.keys(m.counters)).toHaveLength(0);
    expect(Object.keys(m.histograms)).toHaveLength(0);
  });

  it("handles empty histograms", () => {
    expect(getMetrics().histograms).toEqual({});
  });

  it("keeps compatibility counters for non-chat instrumentation", () => {
    incrementCounter("legacy.counter", 2);
    expect(getMetrics().counters["legacy.counter"]).toBe(2);
  });
});
