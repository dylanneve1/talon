/**
 * The routing decision itself.
 *
 * A pin always wins, the disabled switch is byte-identical to pre-router
 * behaviour, and otherwise the most headroom under the ceiling takes the
 * job — with the documented tie-breaks and the task-class veto.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";
import type { TalonConfig } from "../core/config/index.js";

const listAvailableBackends = vi.hoisted(() => vi.fn());
const getPooledBackend = vi.hoisted(() => vi.fn());
const getPoolConfig = vi.hoisted(() => vi.fn());
vi.mock("../core/engine/backend-controller/index.js", () => ({
  listAvailableBackends,
  getPooledBackend,
  getPoolConfig,
}));

const { chooseBackend, taskClassForEffort } =
  await import("../core/engine/backend-router/router.js");
const { resetHeadroomCacheForTest } =
  await import("../core/engine/backend-router/headroom.js");

/** A pooled backend that reports one plan window at `percent` used. */
function planned(percent: number) {
  return {
    background: {},
    usage: {
      getPlanUsage: async () => ({
        fetchedAt: Date.now(),
        windows: [{ label: "5h", percent }],
      }),
    },
  };
}

/** A pooled backend that can host runs but reports nothing. */
function silent() {
  return { background: {} };
}

/** Wire the pool mocks from an id → fake-backend map. */
function pool(entries: Record<string, unknown>): void {
  listAvailableBackends.mockReturnValue(
    Object.keys(entries).map((id) => ({ id, label: id })),
  );
  getPooledBackend.mockImplementation((id: string) => entries[id] ?? null);
}

function config(overrides: Partial<TalonConfig> = {}): TalonConfig {
  return overrides as TalonConfig;
}

beforeEach(() => {
  listAvailableBackends.mockReset();
  getPooledBackend.mockReset();
  getPoolConfig.mockReset();
  getPoolConfig.mockReturnValue(null);
  resetHeadroomCacheForTest();
});

describe("pins", () => {
  it("an explicit backend wins outright, without measuring anything", async () => {
    pool({ claude: planned(99), agy: planned(1) });
    const decision = await chooseBackend({
      purpose: "subagent",
      requestedBackendId: "claude",
      chatBackendId: "agy",
      config: config(),
    });
    expect(decision.backendId).toBe("claude");
    expect(decision.reason).toBe("pinned");
    expect(decision.routed).toBe(false);
  });

  it("an explicit model pins the caller's backend", async () => {
    pool({ claude: planned(99), agy: planned(1) });
    const decision = await chooseBackend({
      purpose: "cron",
      requestedModel: "opus",
      chatBackendId: "claude",
      config: config(),
    });
    expect(decision.backendId).toBe("claude");
    expect(decision.model).toBe("opus");
    expect(decision.reason).toBe("pinned");
  });
});

describe("the disable switch", () => {
  it("returns the caller's own backend with reason 'disabled'", async () => {
    pool({ claude: planned(99), agy: planned(1) });
    const decision = await chooseBackend({
      purpose: "heartbeat",
      chatBackendId: "claude",
      config: config({ router: { enabled: false, ceilingPercent: 85 } }),
    });
    expect(decision).toMatchObject({
      backendId: "claude",
      reason: "disabled",
      routed: false,
    });
  });
});

describe("ranking", () => {
  it("picks the backend with the most headroom", async () => {
    pool({ claude: planned(70), codex: planned(20), agy: planned(45) });
    const decision = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "claude",
      config: config(),
    });
    expect(decision.backendId).toBe("codex");
    expect(decision.routed).toBe(true);
    expect(decision.reason).toContain("most headroom 80%");
  });

  it("excludes a candidate at or above the ceiling", async () => {
    // codex has the most headroom of the two under the ceiling…
    pool({ claude: planned(90), codex: planned(60) });
    const overCeiling = await chooseBackend({
      purpose: "cron",
      chatBackendId: "claude",
      config: config(),
    });
    expect(overCeiling.backendId).toBe("codex");

    // …and with claude back under it, claude's larger headroom wins.
    resetHeadroomCacheForTest();
    pool({ claude: planned(10), codex: planned(60) });
    const underCeiling = await chooseBackend({
      purpose: "cron",
      chatBackendId: "codex",
      config: config(),
    });
    expect(underCeiling.backendId).toBe("claude");
  });

  it("honours a custom ceilingPercent", async () => {
    pool({ claude: planned(50), codex: planned(20) });
    const decision = await chooseBackend({
      purpose: "cron",
      chatBackendId: "claude",
      // A ceiling of 15 puts BOTH over it, so the least-spent one runs.
      config: config({ router: { enabled: true, ceilingPercent: 15 } }),
    });
    expect(decision.backendId).toBe("codex");
    expect(decision.reason).toContain("over the ceiling");
  });

  it("degrades to the least-spent backend when everything is over the ceiling", async () => {
    pool({ claude: planned(97), codex: planned(91) });
    const decision = await chooseBackend({
      purpose: "heartbeat",
      chatBackendId: "claude",
      config: config(),
    });
    expect(decision.backendId).toBe("codex");
    expect(decision.routed).toBe(true);
    expect(decision.reason).toContain("over the ceiling");
  });

  it("prefers the caller's own backend on a tie", async () => {
    pool({ claude: planned(30), codex: planned(30) });
    const fromCodex = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "codex",
      config: config(),
    });
    expect(fromCodex.backendId).toBe("codex");

    resetHeadroomCacheForTest();
    pool({ claude: planned(30), codex: planned(30) });
    const fromClaude = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "claude",
      config: config(),
    });
    expect(fromClaude.backendId).toBe("claude");
  });

  it("ranks an unmeasured backend below a measured one on a tie", async () => {
    // Both read as fully empty; only claude can prove it.
    pool({ claude: planned(0), kilo: silent() });
    const decision = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "kilo",
      config: config(),
    });
    expect(decision.backendId).toBe("claude");
  });

  it("leaves a cold backend out unless it has a declared budget", async () => {
    listAvailableBackends.mockReturnValue([
      { id: "claude", label: "claude" },
      { id: "agy", label: "agy" },
    ]);
    // agy is registered but not pooled — nothing is known about it.
    getPooledBackend.mockImplementation((id: string) =>
      id === "claude" ? planned(80) : null,
    );
    const withoutBudget = await chooseBackend({
      purpose: "cron",
      chatBackendId: "claude",
      config: config(),
    });
    expect(withoutBudget.backendId).toBe("claude");

    resetHeadroomCacheForTest();
    const withBudget = await chooseBackend({
      purpose: "cron",
      chatBackendId: "claude",
      config: config({ backendBudgets: { agy: { tokensPer5h: 1_000_000 } } }),
    });
    expect(withBudget.backendId).toBe("agy");
  });

  it("falls back to the caller's backend when nothing is available", async () => {
    listAvailableBackends.mockReturnValue([]);
    getPooledBackend.mockReturnValue(null);
    const decision = await chooseBackend({
      purpose: "cron",
      chatBackendId: "claude",
      config: config(),
    });
    expect(decision).toMatchObject({ backendId: "claude", routed: false });
  });
});

describe("task-class hints", () => {
  it("'reasoning' vetoes everything but claude", async () => {
    pool({ claude: planned(60), codex: planned(5) });
    const decision = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "codex",
      config: config(),
      hints: { taskClass: "reasoning" },
    });
    expect(decision.backendId).toBe("claude");
  });

  it("will not send required work to a backend that is over the ceiling", async () => {
    // The class requires claude, but claude's plan is spent — the ceiling is
    // applied first, so the veto has nothing left to require and codex runs.
    pool({ claude: planned(93), codex: planned(20) });
    const decision = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "claude",
      config: config(),
      hints: { taskClass: "reasoning" },
    });
    expect(decision.backendId).toBe("codex");
  });

  it("keeps an answer when the required backend isn't a candidate", async () => {
    pool({ codex: planned(5), agy: planned(50) });
    const decision = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "codex",
      config: config(),
      hints: { taskClass: "reasoning" },
    });
    expect(decision.backendId).toBe("codex");
  });

  it("'mechanical' breaks a tie towards the cheap backend", async () => {
    pool({ claude: planned(20), agy: planned(20) });
    const decision = await chooseBackend({
      purpose: "cron",
      // Neither is the caller's backend, so the hint is what decides.
      chatBackendId: "codex",
      config: config(),
      hints: { taskClass: "mechanical" },
    });
    expect(decision.backendId).toBe("agy");
  });

  it("'coding' breaks a tie towards codex, but never beats headroom", async () => {
    pool({ claude: planned(20), codex: planned(20) });
    const tie = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "agy",
      config: config(),
      hints: { taskClass: "coding" },
    });
    expect(tie.backendId).toBe("codex");

    resetHeadroomCacheForTest();
    pool({ claude: planned(5), codex: planned(60) });
    const headroomWins = await chooseBackend({
      purpose: "subagent",
      chatBackendId: "agy",
      config: config(),
      hints: { taskClass: "coding" },
    });
    expect(headroomWins.backendId).toBe("claude");
  });

  it("maps high/xhigh effort to the reasoning class and nothing else", () => {
    expect(taskClassForEffort("xhigh")).toBe("reasoning");
    expect(taskClassForEffort("high")).toBe("reasoning");
    expect(taskClassForEffort("medium")).toBeUndefined();
    expect(taskClassForEffort(undefined)).toBeUndefined();
  });
});
