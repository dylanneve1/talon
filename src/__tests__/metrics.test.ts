import { describe, it, expect, beforeEach } from "vitest";
import {
  incrementCounter,
  recordHistogram,
  getMetrics,
  resetMetrics,
  sanitizeMetricLabel,
} from "../util/metrics.js";

describe("metrics", () => {
  beforeEach(() => resetMetrics());

  it("increments counters", () => {
    incrementCounter("test.count");
    incrementCounter("test.count");
    incrementCounter("test.count", 3);
    expect(getMetrics().counters["test.count"]).toBe(5);
  });

  it("records histograms with percentiles", () => {
    for (let i = 1; i <= 100; i++) recordHistogram("latency", i);
    const h = getMetrics().histograms["latency"];
    expect(h.count).toBe(100);
    expect(h.p50).toBe(51);
    expect(h.p95).toBe(96);
    expect(h.p99).toBe(100);
    expect(h.avg).toBe(51);
  });

  it("caps histogram at MAX_HISTOGRAM_SIZE", () => {
    for (let i = 0; i < 1500; i++) recordHistogram("big", i);
    expect(getMetrics().histograms["big"].count).toBe(1000);
  });

  it("resets all metrics", () => {
    incrementCounter("x");
    recordHistogram("y", 1);
    resetMetrics();
    const m = getMetrics();
    expect(Object.keys(m.counters)).toHaveLength(0);
    expect(Object.keys(m.histograms)).toHaveLength(0);
  });

  it("handles empty histograms", () => {
    expect(getMetrics().histograms).toEqual({});
  });

  it("drops NaN, Infinity, and -Infinity from histograms", () => {
    recordHistogram("clean", 10);
    recordHistogram("clean", NaN);
    recordHistogram("clean", Infinity);
    recordHistogram("clean", -Infinity);
    recordHistogram("clean", 20);
    const h = getMetrics().histograms["clean"];
    expect(h.count).toBe(2);
    expect(h.avg).toBe(15);
  });

  it("caps counter keys at MAX_METRIC_KEYS", () => {
    // Fill up to the cap (500)
    for (let i = 0; i < 500; i++) incrementCounter(`key_${i}`);
    expect(Object.keys(getMetrics().counters)).toHaveLength(500);
    // New key beyond cap is silently dropped
    incrementCounter("overflow_key");
    expect(getMetrics().counters["overflow_key"]).toBeUndefined();
    // Existing keys still work
    incrementCounter("key_0", 5);
    expect(getMetrics().counters["key_0"]).toBe(6);
  });

  it("caps histogram keys at MAX_METRIC_KEYS", () => {
    for (let i = 0; i < 500; i++) recordHistogram(`h_${i}`, i);
    expect(Object.keys(getMetrics().histograms)).toHaveLength(500);
    recordHistogram("overflow_hist", 42);
    expect(getMetrics().histograms["overflow_hist"]).toBeUndefined();
  });
});

describe("sanitizeMetricLabel", () => {
  it("passes well-formed labels through (lowercased)", () => {
    expect(sanitizeMetricLabel("send_message")).toBe("send_message");
    expect(sanitizeMetricLabel("SendMessage")).toBe("sendmessage");
  });

  it("replaces unsafe characters with underscores", () => {
    expect(sanitizeMetricLabel("foo.bar/baz")).toBe("foo_bar_baz");
    expect(sanitizeMetricLabel("hello world!")).toBe("hello_world");
  });

  it("buckets empty / non-string / all-garbage input as 'unknown'", () => {
    expect(sanitizeMetricLabel("")).toBe("unknown");
    expect(sanitizeMetricLabel("!!!")).toBe("unknown");
    expect(sanitizeMetricLabel(undefined as unknown as string)).toBe("unknown");
  });

  it("truncates long input to 40 chars", () => {
    const result = sanitizeMetricLabel("a".repeat(200));
    expect(result.length).toBeLessThanOrEqual(40);
  });
});
