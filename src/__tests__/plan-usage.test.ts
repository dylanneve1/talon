import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parsePlanUsage } from "../backend/claude-sdk/plan-usage.js";
import { buildPlanDisplay } from "../frontend/shared/status-context.js";
import { setTimezone } from "../util/time.js";

/** Shape of one row as the usage endpoint reports it. */
function limit(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "weekly_all",
    group: "weekly",
    percent: 12,
    severity: "normal",
    resets_at: "2026-08-06T12:00:00.149270+00:00",
    scope: null,
    is_active: true,
    ...over,
  };
}

describe("parsePlanUsage", () => {
  it("labels the documented window kinds", () => {
    const usage = parsePlanUsage(
      {
        limits: [
          limit({ kind: "session", percent: 4 }),
          limit({ kind: "weekly_all", percent: 12 }),
          limit({
            kind: "weekly_scoped",
            percent: 0,
            resets_at: null,
            scope: {
              model: { id: null, display_name: "Fable" },
              surface: null,
            },
          }),
        ],
      },
      "max",
    );

    expect(usage?.plan).toBe("max");
    expect(usage?.windows.map((w) => w.label)).toEqual(["5h", "7d", "Fable"]);
  });

  it("keeps a scoped window that is reported at zero", () => {
    const usage = parsePlanUsage({
      limits: [
        limit({
          kind: "weekly_scoped",
          percent: 0,
          resets_at: null,
          scope: { model: { display_name: "Fable" } },
        }),
      ],
    });
    expect(usage?.windows).toEqual([{ label: "Fable", percent: 0 }]);
  });

  it("skips undocumented kinds and unnamed scopes", () => {
    const usage = parsePlanUsage({
      limits: [
        limit(),
        limit({ kind: "monthly_experiment", percent: 90 }),
        limit({ kind: "weekly_scoped", scope: null }),
      ],
    });
    expect(usage?.windows.map((w) => w.label)).toEqual(["7d"]);
  });

  it("clamps and rounds the percentage", () => {
    const usage = parsePlanUsage({
      limits: [
        limit({ kind: "session", percent: 4.6 }),
        limit({ kind: "weekly_all", percent: 140 }),
        limit({
          kind: "weekly_scoped",
          percent: undefined,
          scope: { model: { display_name: "Fable" } },
        }),
      ],
    });
    expect(usage?.windows.map((w) => w.percent)).toEqual([5, 100, 0]);
  });

  it("returns undefined when nothing renderable came back", () => {
    expect(parsePlanUsage({})).toBeUndefined();
    expect(parsePlanUsage(null)).toBeUndefined();
    expect(parsePlanUsage({ limits: [] })).toBeUndefined();
    expect(
      parsePlanUsage({ limits: [limit({ kind: "codename_window" })] }),
    ).toBeUndefined();
  });
});

describe("buildPlanDisplay", () => {
  beforeAll(() => setTimezone("UTC"));
  afterAll(() => setTimezone(undefined));

  it("renders a bar per window", () => {
    const display = buildPlanDisplay(
      {
        plan: "max",
        fetchedAt: Date.now(),
        windows: [
          { label: "5h", percent: 0 },
          { label: "7d", percent: 50 },
        ],
      },
      10,
    );

    expect(display?.windows[0]?.bar).toBe("░".repeat(10));
    expect(display?.windows[1]?.bar).toBe("█".repeat(5) + "░".repeat(5));
    expect(display?.ageLabel).toBeUndefined();
  });

  it("rounds a reset reported a second short of the boundary", () => {
    const today = new Date().toISOString().slice(0, 10);
    const display = buildPlanDisplay({
      fetchedAt: Date.now(),
      windows: [
        { label: "5h", percent: 3, resetsAt: `${today}T20:59:59.509831+00:00` },
      ],
    });
    expect(display?.windows[0]?.resetLabel).toBe("21:00");
  });

  it("ages figures that are no longer fresh", () => {
    const display = buildPlanDisplay({
      fetchedAt: Date.now() - 12 * 60_000,
      windows: [{ label: "7d", percent: 12 }],
    });
    expect(display?.ageLabel).toBe("12m ago");
  });

  it("hides the section when there is nothing to show", () => {
    expect(buildPlanDisplay(undefined)).toBeNull();
    expect(buildPlanDisplay({ fetchedAt: Date.now(), windows: [] })).toBeNull();
  });
});
