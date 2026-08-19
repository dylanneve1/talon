import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initPlanAlerts,
  checkPlanAlerts,
  resetPlanAlertsForTest,
} from "../core/background/plan-alerts.js";
import type { PlanUsage } from "../core/agent-runtime/capabilities.js";

const getPooledBackend = vi.hoisted(() => vi.fn());
vi.mock("../core/engine/backend-controller/index.js", () => ({
  getPooledBackend,
}));

let sent: string[] = [];

function planUsage(windows: PlanUsage["windows"]): {
  usage: { getPlanUsage: () => Promise<PlanUsage> };
} {
  return {
    usage: {
      getPlanUsage: async () => ({
        plan: "max",
        fetchedAt: Date.now(),
        windows,
      }),
    },
  };
}

function arm(threshold = 80): void {
  initPlanAlerts({
    sendMessage: async (_chatId, text) => {
      sent.push(text);
    },
    enabled: true,
    threshold,
    chatId: "123",
  });
}

describe("plan alerts", () => {
  beforeEach(() => {
    sent = [];
    getPooledBackend.mockReset();
  });
  afterEach(() => resetPlanAlertsForTest());

  it("warns once a window crosses the threshold", async () => {
    getPooledBackend.mockReturnValue(
      planUsage([{ label: "7d", percent: 82, resetsAt: undefined }]),
    );
    arm();
    await checkPlanAlerts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("7d");
    expect(sent[0]).toContain("82%");
  });

  it("stays quiet below the threshold", async () => {
    getPooledBackend.mockReturnValue(planUsage([{ label: "7d", percent: 79 }]));
    arm();
    await checkPlanAlerts();
    expect(sent).toEqual([]);
  });

  it("does not repeat within the same reset cycle", async () => {
    getPooledBackend.mockReturnValue(
      planUsage([
        { label: "7d", percent: 82, resetsAt: "2026-08-06T12:00:00Z" },
      ]),
    );
    arm();
    await checkPlanAlerts();
    await checkPlanAlerts();
    await checkPlanAlerts();
    expect(sent).toHaveLength(1);
  });

  it("warns again in the next reset cycle", async () => {
    getPooledBackend.mockReturnValue(
      planUsage([
        { label: "7d", percent: 82, resetsAt: "2026-08-06T12:00:00Z" },
      ]),
    );
    arm();
    await checkPlanAlerts();

    getPooledBackend.mockReturnValue(
      planUsage([
        { label: "7d", percent: 91, resetsAt: "2026-08-13T12:00:00Z" },
      ]),
    );
    await checkPlanAlerts();
    expect(sent).toHaveLength(2);
  });

  it("re-arms after a window drops back under the threshold", async () => {
    getPooledBackend.mockReturnValue(
      planUsage([{ label: "Fable", percent: 84 }]),
    );
    arm();
    await checkPlanAlerts();

    getPooledBackend.mockReturnValue(
      planUsage([{ label: "Fable", percent: 5 }]),
    );
    await checkPlanAlerts();

    getPooledBackend.mockReturnValue(
      planUsage([{ label: "Fable", percent: 88 }]),
    );
    await checkPlanAlerts();
    expect(sent).toHaveLength(2);
  });

  it("tracks each window separately", async () => {
    getPooledBackend.mockReturnValue(
      planUsage([
        { label: "5h", percent: 95 },
        { label: "7d", percent: 81 },
        { label: "Fable", percent: 0 },
      ]),
    );
    arm();
    await checkPlanAlerts();
    expect(sent).toHaveLength(2);
  });

  it("sends nothing while disabled", async () => {
    getPooledBackend.mockReturnValue(planUsage([{ label: "7d", percent: 99 }]));
    initPlanAlerts({
      sendMessage: async (_chatId, text) => {
        sent.push(text);
      },
      enabled: false,
      threshold: 80,
      chatId: "123",
    });
    await checkPlanAlerts();
    expect(sent).toEqual([]);
  });

  it("does nothing when no backend reports plan limits", async () => {
    getPooledBackend.mockReturnValue(undefined);
    arm();
    await expect(checkPlanAlerts()).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("keeps a window marked as warned when delivery fails", async () => {
    getPooledBackend.mockReturnValue(planUsage([{ label: "7d", percent: 82 }]));
    let attempts = 0;
    initPlanAlerts({
      sendMessage: async () => {
        attempts += 1;
        throw new Error("frontend down");
      },
      enabled: true,
      threshold: 80,
      chatId: "123",
    });
    await checkPlanAlerts();
    await checkPlanAlerts();
    expect(attempts).toBe(1);
  });
});
