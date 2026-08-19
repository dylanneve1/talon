import { describe, expect, it } from "vitest";
import {
  buildCacheDisplay,
  buildContextDisplay,
  buildContextBreakdown,
  apportionCells,
  estimateContextTokens,
} from "../frontend/shared/status-context.js";

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

describe("apportionCells", () => {
  it("sums to exactly the bar width", () => {
    const cells = apportionCells([6100, 18900, 3400, 171600], 42);
    expect(cells.reduce((a, b) => a + b, 0)).toBe(42);
  });

  it("gives zero-weight segments zero cells", () => {
    expect(apportionCells([0, 100, 0], 10)).toEqual([0, 10, 0]);
  });

  it("does not starve a small nonzero weight of a leftover cell before a large one", () => {
    // Largest-remainder: 1 leftover cell goes to the largest fractional part.
    // 3 equal weights over 10 cells → 3,3,3 floor + 1 leftover.
    const cells = apportionCells([1, 1, 1], 10);
    expect(cells.reduce((a, b) => a + b, 0)).toBe(10);
    expect(cells.every((c) => c >= 3)).toBe(true);
  });

  it("returns all zeros for a zero-width bar or zero total", () => {
    expect(apportionCells([1, 2, 3], 0)).toEqual([0, 0, 0]);
    expect(apportionCells([0, 0], 42)).toEqual([0, 0]);
  });
});

describe("estimateContextTokens", () => {
  it("estimates ~4 chars per token, rounding up", () => {
    expect(estimateContextTokens("")).toBe(0);
    expect(estimateContextTokens("abc")).toBe(1);
    expect(estimateContextTokens("a".repeat(4000))).toBe(1000);
  });
});

describe("buildContextBreakdown", () => {
  it("derives tools as the residual when a real fill is reported", () => {
    const bd = buildContextBreakdown({
      contextTokens: 28_400,
      contextWindow: 200_000,
      systemTokens: 6_100,
      conversationTokens: 3_400,
    });
    expect(bd.known).toBe(true);
    expect(bd.windowKnown).toBe(true);
    expect(bd.used).toBe(28_400);
    const byKey = Object.fromEntries(bd.segments.map((s) => [s.key, s.tokens]));
    expect(byKey.system).toBe(6_100);
    expect(byKey.conversation).toBe(3_400);
    // Tools = used − system − conversation.
    expect(byKey.tools).toBe(28_400 - 6_100 - 3_400);
    expect(bd.free).toBe(200_000 - 28_400);
  });

  it("segments plus free sum to the window", () => {
    const bd = buildContextBreakdown({
      contextTokens: 742_000,
      contextWindow: 1_000_000,
      systemTokens: 9_200,
      conversationTokens: 610_000,
    });
    const sum = bd.segments.reduce((a, s) => a + s.tokens, 0) + bd.free;
    expect(sum).toBe(1_000_000);
  });

  it("clamps an overshooting conversation estimate to the real fill", () => {
    // Stored history estimates 150k, but the model only actually holds 100k
    // after compaction. Conversation must shrink; tools must not go negative.
    const bd = buildContextBreakdown({
      contextTokens: 100_000,
      contextWindow: 200_000,
      systemTokens: 8_000,
      conversationTokens: 150_000,
    });
    const byKey = Object.fromEntries(bd.segments.map((s) => [s.key, s.tokens]));
    expect(byKey.tools).toBe(0);
    expect(byKey.conversation).toBe(100_000 - 8_000);
    expect(bd.segments.reduce((a, s) => a + s.tokens, 0)).toBe(100_000);
  });

  it("omits tools and shows only measured parts when no fill is reported", () => {
    const bd = buildContextBreakdown({
      contextWindow: 200_000,
      systemTokens: 6_100,
      conversationTokens: 0,
    });
    expect(bd.segments.map((s) => s.key)).toEqual(["system", "conversation"]);
    expect(bd.used).toBe(6_100);
    expect(bd.free).toBe(200_000 - 6_100);
  });

  it("has no free space and no window percentages when the window is unknown", () => {
    const bd = buildContextBreakdown({
      contextTokens: 30_000,
      systemTokens: 6_000,
      conversationTokens: 4_000,
    });
    expect(bd.windowKnown).toBe(false);
    expect(bd.free).toBe(0);
    expect(bd.usedPct).toBe(0);
    // Percentages fall back to share-of-used.
    const sys = bd.segments.find((s) => s.key === "system")!;
    expect(sys.pct).toBe(20); // 6000 / 30000
  });

  it("warns at ≥80% of the window", () => {
    expect(
      buildContextBreakdown({
        contextTokens: 160_000,
        contextWindow: 200_000,
        systemTokens: 8_000,
        conversationTokens: 100_000,
      }).warn,
    ).toBe(true);
    expect(
      buildContextBreakdown({
        contextTokens: 100_000,
        contextWindow: 200_000,
        systemTokens: 8_000,
        conversationTokens: 50_000,
      }).warn,
    ).toBe(false);
  });

  it("reports not-known when there is nothing to show", () => {
    const bd = buildContextBreakdown({
      systemTokens: 0,
      conversationTokens: 0,
    });
    expect(bd.known).toBe(false);
  });
});
