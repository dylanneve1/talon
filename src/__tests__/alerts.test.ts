import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  activeAlerts,
  configureAlerts,
  raiseAlert,
  resetAlertsForTest,
  resolveAlert,
} from "../core/frontend-runtime/alerts.js";

const sent: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  resetAlertsForTest(async (text) => {
    sent.push(text);
  });
});

describe("alerts", () => {
  it("delivers once per cooldown and folds repeats into the next delivery", () => {
    raiseAlert("k", "down");
    raiseAlert("k", "still down");
    raiseAlert("k", "still down");
    expect(sent).toEqual(["🔴 down"]);
    vi.advanceTimersByTime(30 * 60_000);
    raiseAlert("k", "down again", { severity: "critical" });
    expect(sent[1]).toBe("🚨 down again\n(+2 more since the last alert)");
  });

  it("announces recovery only for a delivered alert", () => {
    resolveAlert("never-raised");
    expect(sent).toEqual([]);
    raiseAlert("k", "down", { severity: "warn" });
    vi.advanceTimersByTime(5 * 60_000);
    resolveAlert("k", "Back up");
    expect(sent).toEqual(["⚠️ down", "✅ Back up (after 5 min)"]);
    expect(activeAlerts()).toEqual([]);
  });

  it("tracks but does not deliver when disabled", () => {
    configureAlerts({ enabled: false });
    raiseAlert("k", "down");
    expect(sent).toEqual([]);
    expect(activeAlerts().map((a) => a.key)).toEqual(["k"]);
  });
});
