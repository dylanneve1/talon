import { describe, expect, it } from "vitest";
import {
  buildCacheDisplay,
  buildContextDisplay,
} from "../frontend/status-context.js";

describe("status context display", () => {
  it("uses authoritative contextTokens when present", () => {
    const display = buildContextDisplay({
      contextTokens: 80_000,
      lastPromptTokens: 12_800_000,
      contextWindow: 100_000,
    });

    expect(display.known).toBe(true);
    expect(display.used).toBe(80_000);
    expect(display.pct).toBe(80);
    expect(display.warn).toBe(true);
  });

  it("uses lastPromptTokens as a fallback only when it fits in the window", () => {
    const display = buildContextDisplay({
      contextTokens: 0,
      lastPromptTokens: 120_000,
      contextWindow: 272_000,
    });

    expect(display.known).toBe(true);
    expect(display.used).toBe(120_000);
    expect(display.pct).toBe(44);
  });

  it("does not present impossible cached/cumulative usage as context fill", () => {
    const display = buildContextDisplay({
      contextTokens: 0,
      lastPromptTokens: 12_800_000,
      contextWindow: 272_000,
    });

    expect(display.known).toBe(false);
    expect(display.used).toBe(0);
    expect(display.pct).toBe(0);
    expect(display.warn).toBe(false);
    expect(display.bar).toBe("░".repeat(20));
  });
});

describe("cache display", () => {
  it("hides the cache block when the backend advertises no support", () => {
    expect(
      buildCacheDisplay({
        cacheMetrics: "none",
        inputTokens: 100,
        cacheRead: 50,
        cacheWrite: 25,
      }),
    ).toBeNull();
  });

  it("renders read-only cache telemetry without write stats", () => {
    const display = buildCacheDisplay({
      cacheMetrics: "read",
      inputTokens: 100,
      cacheRead: 50,
      cacheWrite: 25,
    });

    expect(display).toEqual({
      hitPct: 33,
      read: 50,
      write: 0,
      showsWrite: false,
    });
  });

  it("renders read-write cache telemetry, excluding write from hit-pct denominator", () => {
    // Effective input = inputTokens + cacheRead = 100 + 50 = 150
    // cacheWrite (25) must NOT dilute the denominator — those tokens are
    // being written TO the cache, not served FROM it. Matches the
    // canonical formula in src/backend/shared/usage.ts:cacheHitPercent.
    const display = buildCacheDisplay({
      cacheMetrics: "readwrite",
      inputTokens: 100,
      cacheRead: 50,
      cacheWrite: 25,
    });

    expect(display).toEqual({
      hitPct: 33,
      read: 50,
      write: 25,
      showsWrite: true,
    });
  });

  it("returns 0% when there's no effective input", () => {
    expect(
      buildCacheDisplay({
        cacheMetrics: "readwrite",
        inputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toEqual({ hitPct: 0, read: 0, write: 0, showsWrite: true });
  });
});
