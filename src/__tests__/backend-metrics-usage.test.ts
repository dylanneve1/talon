/**
 * Token/cache usage piping through the unified turn metrics.
 *
 * Before this, every backend computed a TokenUsageSnapshot per turn and
 * the cache-hit ratio only survived as a transient log line — cache
 * efficiency over time (the signal that catches prompt-cache
 * regressions) was unanswerable. recordTurnMetrics now aggregates the
 * snapshot into counters + a cache_hit_percent histogram.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordTurnMetrics } from "../backend/shared/metrics.js";
import { getMetrics, resetMetrics } from "../util/metrics.js";

beforeEach(() => resetMetrics());
afterEach(() => resetMetrics());

describe("recordTurnMetrics usage piping", () => {
  it("aggregates token counters globally and per backend", () => {
    recordTurnMetrics({
      backend: "claude",
      durationMs: 100,
      usage: {
        inputTokens: 20,
        outputTokens: 450,
        cacheRead: 8000,
        cacheWrite: 0,
      },
    });
    recordTurnMetrics({
      backend: "codex",
      durationMs: 200,
      usage: {
        inputTokens: 1000,
        outputTokens: 50,
        cacheRead: 3000,
        cacheWrite: 700,
      },
    });

    const { counters } = getMetrics();
    expect(counters["tokens.input_total"]).toBe(1020);
    expect(counters["tokens.output_total"]).toBe(500);
    expect(counters["tokens.cache_read_total"]).toBe(11000);
    expect(counters["tokens.cache_write_total"]).toBe(700);
    expect(counters["backend.claude.tokens.input"]).toBe(20);
    expect(counters["backend.claude.tokens.cache_read"]).toBe(8000);
    expect(counters["backend.codex.tokens.output"]).toBe(50);
    expect(counters["backend.codex.tokens.cache_write"]).toBe(700);
  });

  it("records cache_hit_percent histograms per turn", () => {
    recordTurnMetrics({
      backend: "claude",
      durationMs: 100,
      // 8000 / (8000 + 2000) → 80%
      usage: {
        inputTokens: 2000,
        outputTokens: 1,
        cacheRead: 8000,
        cacheWrite: 0,
      },
    });

    const { histograms } = getMetrics();
    expect(histograms["cache_hit_percent"].count).toBe(1);
    expect(histograms["cache_hit_percent"].avg).toBe(80);
    expect(histograms["backend.claude.cache_hit_percent"].avg).toBe(80);
  });

  it("skips the cache histogram for zero-input turns, keeps counters", () => {
    recordTurnMetrics({
      backend: "kilo",
      durationMs: 100,
      usage: { inputTokens: 0, outputTokens: 5, cacheRead: 0, cacheWrite: 0 },
    });

    const { counters, histograms } = getMetrics();
    expect(histograms["cache_hit_percent"]).toBeUndefined();
    expect(counters["tokens.output_total"]).toBe(5);
  });

  it("is a no-op without a usage snapshot (usage-less backends)", () => {
    recordTurnMetrics({ backend: "opencode", durationMs: 100 });

    const { counters } = getMetrics();
    expect(counters["tokens.input_total"]).toBeUndefined();
    expect(counters["queries_total"]).toBe(1);
  });
});
