/**
 * Tests for usage helpers — cache-hit percentage + log summariser.
 */

import { describe, expect, it } from "vitest";
import { cacheHitPercent, summarizeUsage } from "../backend/shared/usage.js";

describe("cacheHitPercent", () => {
  it("returns 0 when input + cache is zero", () => {
    expect(
      cacheHitPercent({
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBe(0);
  });

  it("returns 100 when everything was cached", () => {
    expect(
      cacheHitPercent({
        inputTokens: 0,
        outputTokens: 50,
        cacheRead: 1000,
        cacheWrite: 0,
      }),
    ).toBe(100);
  });

  it("returns 0 when nothing was cached", () => {
    expect(
      cacheHitPercent({
        inputTokens: 1000,
        outputTokens: 50,
        cacheRead: 0,
        cacheWrite: 50,
      }),
    ).toBe(0);
  });

  it("rounds to nearest integer", () => {
    // 750 / (250 + 750) = 75%
    expect(
      cacheHitPercent({
        inputTokens: 250,
        outputTokens: 0,
        cacheRead: 750,
        cacheWrite: 0,
      }),
    ).toBe(75);
  });
});

describe("summarizeUsage", () => {
  const usage = {
    inputTokens: 100,
    outputTokens: 200,
    cacheRead: 50,
    cacheWrite: 25,
  };

  it("formats tokens + cache %", () => {
    const summary = summarizeUsage(usage);
    expect(summary).toContain("in=100");
    expect(summary).toContain("out=200");
    expect(summary).toContain("cache=33%"); // 50/(100+50) = 33%
  });

  it("includes durationMs when provided", () => {
    const summary = summarizeUsage(usage, { durationMs: 2500 });
    expect(summary).toContain("2500ms");
  });

  it("includes toolCalls when non-zero", () => {
    const summary = summarizeUsage(usage, { toolCalls: 3 });
    expect(summary).toContain("tools=3");
  });

  it("omits toolCalls when zero", () => {
    const summary = summarizeUsage(usage, { toolCalls: 0 });
    expect(summary).not.toContain("tools=");
  });

  it("appends suffix", () => {
    const summary = summarizeUsage(usage, { suffix: "fallback" });
    expect(summary).toContain("fallback");
  });
});
