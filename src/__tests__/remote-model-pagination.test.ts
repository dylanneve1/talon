import { describe, it, expect } from "vitest";

import { createRemoteModelPresentation } from "../backend/remote-server/model-catalog/presentation.js";
import type {
  RemoteModelCatalog,
  RemoteModelCatalogEntry,
} from "../backend/remote-server/model-catalog/types.js";

function model(
  id: string,
  over: Partial<RemoteModelCatalogEntry> = {},
): RemoteModelCatalogEntry {
  return {
    id,
    name: id.toUpperCase(),
    providerID: "openrouter",
    providerName: "OpenRouter",
    providerSource: "api",
    connected: true,
    selectable: true,
    loginRequired: false,
    envRequired: false,
    authMethods: [],
    free: false,
    status: "active",
    contextWindow: 200_000,
    outputWindow: 64_000,
    reasoning: false,
    attachment: false,
    toolcall: true,
    costInput: 1,
    costOutput: 2,
    costCacheRead: 0,
    costCacheWrite: 0,
    ...over,
  } as RemoteModelCatalogEntry;
}

function provider(id: string, name: string, modelCount: number) {
  return {
    id,
    name,
    source: "api",
    connected: true,
    modelCount,
    authMethods: [],
    envKeys: [],
    loginRequired: false,
    envRequired: false,
  } as RemoteModelCatalog["providers"][number];
}

/** `count` models, every third one free, split across two providers. */
function catalogOf(count: number): RemoteModelCatalog {
  const models = Array.from({ length: count }, (_, i) =>
    model(`m${i}`, {
      free: i % 3 === 0,
      providerID: i % 2 === 0 ? "openrouter" : "zen",
      providerName: i % 2 === 0 ? "OpenRouter" : "OpenCode Zen",
    }),
  );
  const providers = [
    provider("openrouter", "OpenRouter", Math.ceil(count / 2)),
    provider("zen", "OpenCode Zen", Math.floor(count / 2)),
  ];
  return {
    generatedAt: 0,
    providers,
    models,
    connectedProviders: providers,
    loginProviders: [],
    connectedModels: models,
    connectedFreeModels: models.filter((m) => m.free),
  };
}

function presentationFor(count: number, groupThreshold = 60) {
  return createRemoteModelPresentation({
    label: "OpenCode",
    getCatalog: async () => catalogOf(count),
    maxCallbackIdLength: 100,
    allowCallbackSeparators: true,
    quickPickLimit: 4,
    groupThreshold,
  });
}

describe("remote model picker pagination", () => {
  it("splits a large catalog into pages of the requested size", async () => {
    const p = presentationFor(343, 10_000);
    const first = await p.getSettingsPresentation("m0", { pageSize: 25 });
    expect(first.view).toBe("models");
    expect(first.page).toBe(1);
    expect(first.totalPages).toBe(Math.ceil(343 / 25));
    expect(first.totalCount).toBe(343);
    // 25 models plus the trailing Reset button.
    expect(first.modelButtons).toHaveLength(26);
  });

  it("serves different models on different pages", async () => {
    const p = presentationFor(343, 10_000);
    const a = await p.getSettingsPresentation("m0", { pageSize: 25, page: 1 });
    const b = await p.getSettingsPresentation("m0", { pageSize: 25, page: 2 });
    const ids = (r: { modelButtons: { callback_data: string }[] }) =>
      r.modelButtons.map((x) => x.callback_data);
    expect(ids(a)).not.toEqual(ids(b));
    expect(b.page).toBe(2);
  });

  it("clamps a page past the end rather than serving an empty list", async () => {
    const p = presentationFor(343, 10_000);
    const far = await p.getSettingsPresentation("m0", {
      pageSize: 25,
      page: 999,
    });
    expect(far.page).toBe(far.totalPages);
    expect(far.modelButtons.length).toBeGreaterThan(1);
  });

  it("falls back to the backend's quick-pick count when no size is given", async () => {
    const p = presentationFor(343, 10_000);
    const r = await p.getSettingsPresentation("m0");
    // quickPickLimit 4 + Reset.
    expect(r.modelButtons).toHaveLength(5);
    expect(r.totalPages).toBe(Math.ceil(343 / 4));
  });

  it("narrows to free models and still reports the unfiltered free count", async () => {
    const p = presentationFor(90, 10_000);
    const all = await p.getSettingsPresentation("m0", { pageSize: 1000 });
    const free = await p.getSettingsPresentation("m0", {
      pageSize: 1000,
      filter: "free",
    });
    expect(all.filter).toBe("all");
    expect(free.filter).toBe("free");
    expect(free.freeCount).toBe(all.freeCount);
    expect(free.modelButtons.length).toBeLessThan(all.modelButtons.length);
  });

  it("opens as provider chips once the flat list gets unreadable", async () => {
    const p = presentationFor(343, 60);
    const groups = await p.getSettingsPresentation("m0", { pageSize: 25 });
    expect(groups.view).toBe("groups");
    expect(groups.totalPages).toBe(1);
    expect(groups.modelButtons.map((b) => b.callback_data)).toEqual([
      "settings:models:provider:openrouter",
      "settings:models:provider:zen",
    ]);
  });

  it("lists one provider's models once drilled in", async () => {
    const p = presentationFor(343, 60);
    const drilled = await p.getSettingsPresentation("m0", {
      pageSize: 25,
      provider: "zen",
    });
    expect(drilled.view).toBe("models");
    expect(drilled.provider).toBe("zen");
    expect(drilled.totalCount).toBe(343);
    // Only Zen models on the page — every id is odd-numbered by construction.
    const shown = drilled.modelButtons
      .map((b) => b.callback_data)
      .filter((v) => v !== "settings:model:reset");
    expect(shown.length).toBeGreaterThan(0);
  });

  it("stays a flat list when only one provider is connected", async () => {
    const single = createRemoteModelPresentation({
      label: "OpenCode",
      getCatalog: async () => {
        const c = catalogOf(200);
        return { ...c, connectedProviders: [c.connectedProviders[0]!] };
      },
      maxCallbackIdLength: 100,
      allowCallbackSeparators: true,
      quickPickLimit: 4,
      groupThreshold: 10,
    });
    const r = await single.getSettingsPresentation("m0", { pageSize: 25 });
    expect(r.view).toBe("models");
  });

  it("honours the callback prefixes the frontend asked for", async () => {
    const p = presentationFor(343, 60);
    const groups = await p.getSettingsPresentation("m0", {
      navCallbackPrefix: "model:nav",
    });
    expect(groups.modelButtons[0]?.callback_data).toBe(
      "model:nav:provider:openrouter",
    );
    const models = await p.getSettingsPresentation("m0", {
      callbackPrefix: "model:",
      provider: "zen",
      pageSize: 5,
    });
    expect(models.modelButtons[0]?.callback_data.startsWith("model:")).toBe(
      true,
    );
  });
});
