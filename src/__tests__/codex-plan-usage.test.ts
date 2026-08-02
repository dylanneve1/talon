import { describe, it, expect } from "vitest";
import { parseCodexUsage } from "../backend/codex/plan-usage.js";

/** The shape the ChatGPT backend returns for a plan install. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 26,
        limit_window_seconds: 604800,
        reset_at: 1786225824,
      },
      secondary_window: null,
    },
    ...over,
  };
}

describe("parseCodexUsage", () => {
  it("labels a window by its length and converts the reset to ISO", () => {
    const usage = parseCodexUsage(body());
    expect(usage?.plan).toBe("plus");
    expect(usage?.windows).toEqual([
      {
        label: "7d",
        percent: 26,
        resetsAt: new Date(1786225824 * 1000).toISOString(),
      },
    ]);
  });

  it("keeps both windows when the plan still has a shorter one", () => {
    const usage = parseCodexUsage(
      body({
        rate_limit: {
          primary_window: {
            used_percent: 26,
            limit_window_seconds: 604800,
            reset_at: 1786225824,
          },
          secondary_window: {
            used_percent: 4,
            limit_window_seconds: 18000,
            reset_at: 1786000000,
          },
        },
      }),
    );
    expect(usage?.windows.map((w) => w.label)).toEqual(["7d", "5h"]);
  });

  it("drops a window the plan no longer has", () => {
    // The 5-hour window was retired; a null secondary is normal, not a gap.
    const usage = parseCodexUsage(body());
    expect(usage?.windows).toHaveLength(1);
  });

  it("clamps and rounds the percentage", () => {
    const usage = parseCodexUsage(
      body({
        rate_limit: {
          primary_window: {
            used_percent: 99.6,
            limit_window_seconds: 604800,
          },
        },
      }),
    );
    expect(usage?.windows[0]?.percent).toBe(100);
    expect(usage?.windows[0]?.resetsAt).toBeUndefined();
  });

  it("returns undefined when there is no plan to report", () => {
    expect(parseCodexUsage(null)).toBeUndefined();
    expect(parseCodexUsage({})).toBeUndefined();
    expect(parseCodexUsage({ rate_limit: {} })).toBeUndefined();
    expect(
      parseCodexUsage({ rate_limit: { primary_window: {} } }),
    ).toBeUndefined();
  });
});
