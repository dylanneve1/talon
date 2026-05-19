/**
 * Tests for the `model-menu.ts` controller:
 *
 *   - `resolveBackendForChat` — pool-first, gateway-fallback,
 *     null when neither is wired. Critical for honouring per-chat
 *     backend overrides in /model.
 *   - `buildModelMenuViewForChat` — assembles the menu state via
 *     the per-chat backend, surfaces `freeOnly` from chat-settings,
 *     and gates the free toggle on the catalog's freeCount.
 *   - `buildModelBrowseViewForChat` — same per-chat backend, plus
 *     filter/page/provider plumbing.
 *   - `buildBackendMenuViewForChat` — cheap pool snapshot for the
 *     backend submenu.
 *   - `toggleChatFreeOnly` — round-trips through chat-settings.
 *
 * Tests use the in-memory backend pool with two registered fake
 * backends so override behaviour can be exercised without
 * spawning real SDKs. `node:fs` is mocked so chat-settings writes
 * don't touch the production state file; chat ids are made unique
 * per test so leftover state from a previous case can't bleed into
 * the next.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock fs BEFORE importing chat-settings so its load() reads empty.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import type {
  QueryBackend,
  ModelPickerResult,
  UnifiedModelInfo,
} from "../core/types.js";
import {
  initBackendPool,
  rebindChat,
  releaseChat,
  resetBackendPoolForTest,
} from "../core/backend-controller.js";
import {
  registerBackend,
  clearBackends,
  type BackendFactory,
} from "../backend/registry.js";
import {
  resolveBackendForChat,
  buildModelMenuViewForChat,
  buildModelBrowseViewForChat,
  buildBackendMenuViewForChat,
  toggleChatFreeOnly,
} from "../frontend/telegram/model-menu.js";
import { setChatModel, setChatFreeOnly } from "../storage/chat-settings.js";
import type { TalonConfig } from "../util/config.js";

let nextChatId = 1000;
function freshChat(): string {
  nextChatId += 1;
  return `mmc-${nextChatId}`;
}

// ── Test fixtures ──────────────────────────────────────────────────────────

function makeFakeBackend(
  label: string,
  picker: ModelPickerResult,
  activeDisplay = "active",
): QueryBackend {
  return {
    query: vi.fn(),
    backendLabel: label,
    getSettingsPresentation: vi.fn().mockResolvedValue(picker),
    getModelInfo: vi.fn().mockResolvedValue({
      id: "active-id",
      displayName: activeDisplay,
      provider: label,
      providerName: label,
      selectable: true,
      reasoning: false,
    } satisfies UnifiedModelInfo),
  };
}

function makeFactory(
  id: string,
  label: string,
  backend: QueryBackend,
): BackendFactory {
  return {
    id,
    label,
    async init() {
      return { backend };
    },
  };
}

const baseConfig = {
  model: "model-a",
  workspace: "/tmp/test",
  backend: "fake-claude",
} as unknown as TalonConfig;

const claudeBackend = makeFakeBackend(
  "Claude SDK",
  {
    modelButtons: [
      { text: "opus", callback_data: "model:opus" },
      { text: "sonnet", callback_data: "model:sonnet" },
    ],
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 0, // no free Claude models — toggle must NOT appear
    totalCount: 2,
    modelDetails: ["2 Claude models"],
    view: "models",
  },
  "Opus",
);

const openrouterBackend = makeFakeBackend(
  "OpenAI Agents",
  {
    modelButtons: [
      {
        text: "owl-alpha · 🆓",
        callback_data: "model:openrouter/owl-alpha",
      },
      {
        text: "gpt-5",
        callback_data: "model:openai/gpt-5",
      },
    ],
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 1, // free model present — toggle MUST appear
    totalCount: 2,
    modelDetails: ["356 models discovered via OpenAI Agents endpoint"],
    view: "models",
  },
  "Owl Alpha",
);

beforeEach(async () => {
  resetBackendPoolForTest();
  clearBackends();
  registerBackend(makeFactory("fake-claude", "Claude SDK", claudeBackend));
  registerBackend(
    makeFactory("fake-openai-agents", "OpenAI Agents", openrouterBackend),
  );
  await initBackendPool(baseConfig, {
    getBridgePort: () => 0,
    frontendName: "telegram",
  });
});

afterEach(() => {
  resetBackendPoolForTest();
  clearBackends();
});

// ── resolveBackendForChat ──────────────────────────────────────────────────

describe("model-menu / resolveBackendForChat", () => {
  it("returns the role:chat backend when no per-chat override is set", () => {
    const c1 = freshChat();
    const be = resolveBackendForChat(c1);
    expect(be).toBe(claudeBackend);
  });

  it("returns the per-chat backend after a rebind", async () => {
    const c1 = freshChat();
    const c2 = freshChat();
    await rebindChat(c1, "fake-openai-agents", baseConfig);
    expect(resolveBackendForChat(c1)).toBe(openrouterBackend);
    // A different chat unaffected.
    expect(resolveBackendForChat(c2)).toBe(claudeBackend);
  });

  it("reverts to role:chat when the chat override is released", async () => {
    const c1 = freshChat();
    await rebindChat(c1, "fake-openai-agents", baseConfig);
    expect(resolveBackendForChat(c1)).toBe(openrouterBackend);
    await releaseChat(c1);
    expect(resolveBackendForChat(c1)).toBe(claudeBackend);
  });

  it("falls back to the gateway's backend when the pool is uninitialised", () => {
    const c1 = freshChat();
    resetBackendPoolForTest();
    const fallback = { backendLabel: "fallback" } as unknown as QueryBackend;
    expect(resolveBackendForChat(c1, { backend: fallback })).toBe(fallback);
  });

  it("returns null when neither pool nor gateway has a backend", () => {
    const c1 = freshChat();
    resetBackendPoolForTest();
    expect(resolveBackendForChat(c1)).toBeNull();
    expect(resolveBackendForChat(c1, { backend: null })).toBeNull();
  });
});

// ── buildModelMenuViewForChat ──────────────────────────────────────────────

describe("model-menu / buildModelMenuViewForChat", () => {
  it("hides the free toggle when the per-chat backend has no free models", async () => {
    const c1 = freshChat();
    const view = await buildModelMenuViewForChat(c1, baseConfig);
    expect(view).not.toBeNull();
    expect(view!.state.showFreeToggle).toBe(false);
  });

  it("shows the free toggle when the per-chat backend reports free models", async () => {
    const c1 = freshChat();
    await rebindChat(c1, "fake-openai-agents", baseConfig);
    const view = await buildModelMenuViewForChat(c1, baseConfig);
    expect(view!.state.showFreeToggle).toBe(true);
  });

  it("queries the per-chat backend (not the role:chat default)", async () => {
    const c1 = freshChat();
    await rebindChat(c1, "fake-openai-agents", baseConfig);
    // Reset call counts collected during prior tests / pool init.
    (
      openrouterBackend.getSettingsPresentation as ReturnType<typeof vi.fn>
    ).mockClear();
    (
      claudeBackend.getSettingsPresentation as ReturnType<typeof vi.fn>
    ).mockClear();
    await buildModelMenuViewForChat(c1, baseConfig);
    expect(openrouterBackend.getSettingsPresentation).toHaveBeenCalledTimes(1);
    expect(claudeBackend.getSettingsPresentation).not.toHaveBeenCalled();
  });

  it("reflects hasBackendOverride on the menu state", async () => {
    const c1 = freshChat();
    const before = await buildModelMenuViewForChat(c1, baseConfig);
    expect(before!.state.hasBackendOverride).toBe(false);
    await rebindChat(c1, "fake-openai-agents", baseConfig);
    const after = await buildModelMenuViewForChat(c1, baseConfig);
    expect(after!.state.hasBackendOverride).toBe(true);
  });

  it("propagates the chat's freeOnly preference to the snapshot call", async () => {
    const c1 = freshChat();
    await rebindChat(c1, "fake-openai-agents", baseConfig);
    setChatFreeOnly(c1, true);
    (
      openrouterBackend.getSettingsPresentation as ReturnType<typeof vi.fn>
    ).mockClear();
    await buildModelMenuViewForChat(c1, baseConfig);
    const args = (
      openrouterBackend.getSettingsPresentation as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(args[1]).toMatchObject({ filter: "free" });
  });

  it("falls back to model-name display when getModelInfo returns nothing", async () => {
    const c1 = freshChat();
    const stripped = makeFakeBackend("Stripped", {
      modelButtons: [],
      page: 1,
      totalPages: 1,
      filter: "all",
      freeCount: 0,
      totalCount: 0,
      modelDetails: [],
      view: "models",
    });
    stripped.getModelInfo = vi.fn().mockResolvedValue(undefined);
    registerBackend(makeFactory("fake-stripped", "Stripped", stripped));
    await rebindChat(c1, "fake-stripped", baseConfig);
    setChatModel(c1, "raw/model-id");
    const view = await buildModelMenuViewForChat(c1, baseConfig);
    expect(view!.state.activeDisplay).toBe("raw/model-id");
  });
});

// ── buildModelBrowseViewForChat ────────────────────────────────────────────

describe("model-menu / buildModelBrowseViewForChat", () => {
  it("returns the per-chat backend's catalog with metadata fields", async () => {
    const c1 = freshChat();
    await rebindChat(c1, "fake-openai-agents", baseConfig);
    const browse = await buildModelBrowseViewForChat(c1, baseConfig, {});
    expect(browse).not.toBeNull();
    expect(browse!.modelButtons).toHaveLength(2);
    expect(browse!.freeCount).toBe(1);
    expect(browse!.totalCount).toBe(2);
  });

  it("threads filter / page / provider into the snapshot call", async () => {
    const c1 = freshChat();
    await rebindChat(c1, "fake-openai-agents", baseConfig);
    (
      openrouterBackend.getSettingsPresentation as ReturnType<typeof vi.fn>
    ).mockClear();
    await buildModelBrowseViewForChat(c1, baseConfig, {
      filter: "free",
      page: 2,
      provider: "openai",
    });
    const args = (
      openrouterBackend.getSettingsPresentation as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(args[1]).toMatchObject({
      filter: "free",
      page: 2,
      provider: "openai",
    });
  });

  it("inherits chat's freeOnly when caller doesn't override filter", async () => {
    const c1 = freshChat();
    await rebindChat(c1, "fake-openai-agents", baseConfig);
    setChatFreeOnly(c1, true);
    (
      openrouterBackend.getSettingsPresentation as ReturnType<typeof vi.fn>
    ).mockClear();
    await buildModelBrowseViewForChat(c1, baseConfig, {});
    const args = (
      openrouterBackend.getSettingsPresentation as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(args[1]).toMatchObject({ filter: "free" });
  });

  it("explicit filter beats chat preference", async () => {
    const c1 = freshChat();
    await rebindChat(c1, "fake-openai-agents", baseConfig);
    setChatFreeOnly(c1, true);
    (
      openrouterBackend.getSettingsPresentation as ReturnType<typeof vi.fn>
    ).mockClear();
    await buildModelBrowseViewForChat(c1, baseConfig, { filter: "all" });
    const args = (
      openrouterBackend.getSettingsPresentation as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(args[1]).toMatchObject({ filter: "all" });
  });
});

// ── buildBackendMenuViewForChat ────────────────────────────────────────────

describe("model-menu / buildBackendMenuViewForChat", () => {
  it("lists available backends from config.enabledBackends order", () => {
    const c1 = freshChat();
    const cfg = {
      ...baseConfig,
      enabledBackends: ["fake-openai-agents", "fake-claude"],
    } as unknown as TalonConfig;
    const menu = buildBackendMenuViewForChat(c1, cfg);
    expect(menu.available.map((b) => b.id)).toEqual([
      "fake-openai-agents",
      "fake-claude",
    ]);
  });

  it("marks the per-chat backend as active when override is pinned", async () => {
    const c1 = freshChat();
    await rebindChat(c1, "fake-openai-agents", baseConfig);
    const menu = buildBackendMenuViewForChat(c1, baseConfig);
    expect(menu.activeBackend.id).toBe("fake-openai-agents");
    expect(menu.hasBackendOverride).toBe(true);
  });

  it("returns the role:chat backend when no override is set", () => {
    const c1 = freshChat();
    const menu = buildBackendMenuViewForChat(c1, baseConfig);
    expect(menu.activeBackend.id).toBe("fake-claude");
    expect(menu.hasBackendOverride).toBe(false);
  });
});

// ── toggleChatFreeOnly ────────────────────────────────────────────────────

describe("model-menu / toggleChatFreeOnly", () => {
  it("flips between on / off and returns the new value", () => {
    const c1 = freshChat();
    expect(toggleChatFreeOnly(c1)).toBe(true);
    expect(toggleChatFreeOnly(c1)).toBe(false);
    expect(toggleChatFreeOnly(c1)).toBe(true);
  });
});
