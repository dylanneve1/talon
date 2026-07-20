/**
 * Tests for getOpenCodeQuickPickModels — the model-picker UI helper used by
 * Telegram, Discord, and Teams settings menus to surface "favourites" with
 * a tight callback budget.
 *
 * Why a dedicated file:
 *   The quick-pick path encodes two non-obvious invariants that are easy to
 *   regress when refactoring the catalog plumbing:
 *
 *     1. The currently-selected model is pinned to the top, even if it
 *        wouldn't otherwise be in the budget. Without this, switching to a
 *        non-free model and reopening settings would hide the current
 *        selection from the quick-pick row.
 *
 *     2. Free connected models come BEFORE non-free connected models when
 *        filling the budget. The Telegram inline-keyboard slots are tiny;
 *        if a refactor flips the precedence, free models stop being one
 *        click away.
 *
 *     3. Model IDs longer than 90 chars are dropped (Discord StringSelectMenu
 *        values cap at 100 chars, leaving ~10 chars for the "settings:model:"
 *        prefix). Without this guard, oversized IDs would silently break the
 *        Discord settings flow.
 *
 *   These are exactly the kind of "easy to forget when reading the diff"
 *   guarantees that benefit from explicit tests.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../backend/kilo/server.js", () => ({
  onServerStop: vi.fn(),
  ensureServer: vi.fn(async () => {
    throw new Error(
      "ensureServer should not be called from kilo-quickpicks tests",
    );
  }),
  getConfig: vi.fn(() => undefined),
  initOpenCodeAgent: vi.fn(),
  stopOpenCodeServer: vi.fn(),
}));

const { getOpenCodeQuickPickModels } = await import("../backend/kilo/index.js");

type Entry = Parameters<typeof getOpenCodeQuickPickModels>[0]["models"][number];

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "default-id",
    name: "Default",
    providerID: "kilo",
    providerName: "Kilo",
    providerSource: "api",
    connected: true,
    selectable: true,
    loginRequired: false,
    envRequired: false,
    authMethods: [],
    free: false,
    status: "active",
    contextWindow: 200_000,
    outputWindow: 128_000,
    reasoning: false,
    attachment: false,
    toolcall: true,
    costInput: 1,
    costOutput: 2,
    costCacheRead: 0,
    costCacheWrite: 0,
    ...overrides,
  };
}

function buildCatalog(
  models: Array<Entry>,
  free: Array<Entry> = models.filter((m) => m.free),
  connected: Array<Entry> = models.filter((m) => m.selectable),
) {
  return {
    generatedAt: Date.now(),
    providers: [],
    connectedProviders: [],
    loginProviders: [],
    connectedModels: connected,
    connectedFreeModels: free,
    models,
  };
}

describe("getOpenCodeQuickPickModels", () => {
  it("pins the current model first even if it isn't free", () => {
    const free = makeEntry({ id: "big-pickle", free: true });
    const current = makeEntry({
      id: "claude-opus-4-7",
      providerID: "anthropic",
      providerName: "Anthropic",
      free: false,
    });
    const catalog = buildCatalog([free, current]);
    const picks = getOpenCodeQuickPickModels(catalog as any, "claude-opus-4-7");
    expect(picks[0].id).toBe("claude-opus-4-7");
    // free model still appears, just after the pinned current.
    expect(picks.map((p) => p.id)).toContain("big-pickle");
  });

  it("does NOT pin a current model that isn't in the catalog", () => {
    const free = makeEntry({ id: "big-pickle", free: true });
    const catalog = buildCatalog([free]);
    // currentModelID points at something that doesn't exist; should silently
    // fall back to free + connected without crashing.
    const picks = getOpenCodeQuickPickModels(catalog as any, "ghost-model");
    expect(picks.map((p) => p.id)).toEqual(["big-pickle"]);
  });

  it("orders free models before non-free connected models", () => {
    const paid = makeEntry({
      id: "claude",
      free: false,
      providerID: "anthropic",
    });
    const free = makeEntry({ id: "big-pickle", free: true });
    const catalog = buildCatalog([paid, free]);
    const picks = getOpenCodeQuickPickModels(catalog as any);
    expect(picks[0].id).toBe("big-pickle");
    expect(picks[1].id).toBe("claude");
  });

  it("does not duplicate a model that's both the current selection and free", () => {
    const free = makeEntry({ id: "big-pickle", free: true });
    const catalog = buildCatalog([free]);
    const picks = getOpenCodeQuickPickModels(catalog as any, "big-pickle");
    expect(picks).toHaveLength(1);
    expect(picks[0].id).toBe("big-pickle");
  });

  it("drops models whose IDs exceed the 90-char Discord-safe budget", () => {
    const ok = makeEntry({ id: "short-id", free: true });
    const oversized = makeEntry({
      // 95 chars — over the 90-char cap.
      id: "x".repeat(95),
      providerID: "openrouter",
      providerName: "OpenRouter",
      free: true,
    });
    const catalog = buildCatalog([ok, oversized]);
    const picks = getOpenCodeQuickPickModels(catalog as any);
    expect(picks.map((p) => p.id)).toEqual(["short-id"]);
  });

  it("respects the 24-model PICK_BUDGET", () => {
    // Build 30 free models — quick-pick should clamp to 24.
    const models: Array<Entry> = Array.from({ length: 30 }, (_, i) =>
      makeEntry({ id: `free-${i}`, free: true }),
    );
    const catalog = buildCatalog(models);
    const picks = getOpenCodeQuickPickModels(catalog as any);
    expect(picks).toHaveLength(24);
  });

  it("fills with non-free connected models when there's budget left after free", () => {
    const free = [
      makeEntry({ id: "free-0", free: true }),
      makeEntry({ id: "free-1", free: true }),
    ];
    const paid = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: `paid-${i}`, providerID: "anthropic", free: false }),
    );
    const catalog = buildCatalog([...free, ...paid]);
    const picks = getOpenCodeQuickPickModels(catalog as any);
    // 2 free + 5 paid = 7 total; all fit under budget.
    expect(picks.map((p) => p.id)).toEqual([
      "free-0",
      "free-1",
      "paid-0",
      "paid-1",
      "paid-2",
      "paid-3",
      "paid-4",
    ]);
  });

  it("returns an empty array when there are no connected models", () => {
    expect(getOpenCodeQuickPickModels(buildCatalog([]) as any)).toEqual([]);
  });

  it("dedupes across the current → free → connected fill order", () => {
    // current model also appears as the first free model — must appear once.
    const m = makeEntry({ id: "big-pickle", free: true });
    const catalog = buildCatalog([m], [m], [m]);
    const picks = getOpenCodeQuickPickModels(catalog as any, "big-pickle");
    const seen = new Set(picks.map((p) => p.id));
    expect(seen.size).toBe(picks.length);
  });
});
