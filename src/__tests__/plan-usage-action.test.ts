/**
 * `plan_usage` and `list_backends` after the plan-aware router.
 *
 * Both used to answer about one backend — `plan_usage` fell back to the
 * pooled Claude instance and said "no plan limits" for everything else.
 * They now answer for the whole fleet, with the same headroom figure the
 * router ranks on, so "which backend has room?" is a tool call.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";

const mockGetBackendIdForChat = vi.hoisted(() => vi.fn(() => "claude"));
const mockGetPooledBackend = vi.hoisted(() => vi.fn());
const mockListAvailableBackends = vi.hoisted(() => vi.fn());
const mockPoolConfig = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("../core/engine/backend-controller/index.js", () => ({
  getBackendForChat: vi.fn(),
  getBackendIdForChat: mockGetBackendIdForChat,
  getAvailableBackends: mockListAvailableBackends,
  listAvailableBackends: mockListAvailableBackends,
  getPoolConfig: () => mockPoolConfig.value,
  getPooledBackend: mockGetPooledBackend,
  acquireBackendInstance: vi.fn(),
  isModelValidForBackend: vi.fn(),
}));

const { modelHandlers } =
  await import("../core/engine/gateway-actions/models.js");
const { resetHeadroomCacheForTest } =
  await import("../core/engine/backend-router/headroom.js");
const { recordBackendUsage, resetBackendLedgerForTest } =
  await import("../core/engine/backend-router/ledger.js");

/** Claude reports a real plan; agy is pooled but has no usage API. */
function twoBackends(claudePercent: number): void {
  mockListAvailableBackends.mockReturnValue([
    { id: "claude", label: "Anthropic" },
    { id: "agy", label: "Antigravity" },
  ]);
  mockGetPooledBackend.mockImplementation((id: string) =>
    id === "claude"
      ? {
          background: {},
          usage: {
            getPlanUsage: async () => ({
              plan: "max",
              fetchedAt: Date.now(),
              windows: [{ label: "5h", percent: claudePercent }],
            }),
          },
        }
      : { background: {} },
  );
}

type Handler = (typeof modelHandlers)[keyof typeof modelHandlers];

async function call(name: "plan_usage" | "list_backends") {
  const handler = modelHandlers[name] as Handler;
  return handler({}, 42, undefined, "42");
}

beforeEach(() => {
  mockListAvailableBackends.mockReset();
  mockGetPooledBackend.mockReset();
  mockGetBackendIdForChat.mockReturnValue("claude");
  mockPoolConfig.value = null;
  resetHeadroomCacheForTest();
  resetBackendLedgerForTest("/tmp/talon-plan-usage-action-test.json");
});

describe("plan_usage", () => {
  it("returns every backend, with a headroom figure for each", async () => {
    twoBackends(30);
    mockPoolConfig.value = {
      backendBudgets: { agy: { tokensPer5h: 1_000_000 } },
    };
    recordBackendUsage("agy", 100_000);

    const result = (await call("plan_usage")) as unknown as {
      ok: boolean;
      backends: {
        id: string;
        headroom: number;
        source: string;
        current: boolean;
      }[];
      text: string;
    };

    expect(result.ok).toBe(true);
    expect(result.backends.map((b) => b.id)).toEqual(["claude", "agy"]);
    expect(result.backends[0]).toMatchObject({
      id: "claude",
      source: "plan",
      headroom: 0.7,
      current: true,
    });
    expect(result.backends[1]).toMatchObject({
      id: "agy",
      source: "ledger",
      headroom: 0.9,
    });
    expect(result.text).toContain("Antigravity");
    expect(result.text).toContain("local budget");
  });

  it("leads with the chat's own backend, whatever the config order", async () => {
    twoBackends(30);
    mockGetBackendIdForChat.mockReturnValue("agy");
    const result = (await call("plan_usage")) as unknown as {
      backends: { id: string }[];
      windows: unknown[];
    };
    expect(result.backends[0]?.id).toBe("agy");
    // The legacy single-backend fields describe the lead entry, which has
    // no plan of its own — so they are empty rather than Claude's.
    expect(result.windows).toEqual([]);
  });

  it("still exposes the lead backend's windows for old callers", async () => {
    twoBackends(55);
    const result = (await call("plan_usage")) as unknown as {
      plan: string | null;
      windows: { label: string; percent: number }[];
    };
    expect(result.plan).toBe("max");
    expect(result.windows).toEqual([{ label: "5h", percent: 55 }]);
  });

  it("says so when there are no backends at all", async () => {
    mockListAvailableBackends.mockReturnValue([]);
    mockGetPooledBackend.mockReturnValue(null);
    const result = (await call("plan_usage")) as unknown as { ok: boolean };
    expect(result.ok).toBe(false);
  });
});

describe("list_backends", () => {
  it("carries headroom alongside each backend", async () => {
    twoBackends(80);
    const result = (await call("list_backends")) as unknown as {
      backends: { id: string; headroom: number | null }[];
      text: string;
    };
    expect(result.backends[0]).toMatchObject({
      id: "claude",
      headroom: 0.2,
      headroomSource: "plan",
    });
    expect(result.text).toContain("20% — 5h 80% used free");
  });
});
