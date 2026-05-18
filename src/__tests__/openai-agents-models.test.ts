/**
 * Tests for the OpenAI Agents backend's model surface.
 *
 * The backend has no hardcoded catalog — everything is driven by
 * `state.endpointModels`, which `init.ts#fetchEndpointModels`
 * populates from the active endpoint's `/models` response. These
 * tests seed that map directly instead of going through a live
 * fetch, so behavior of the resolver, picker, and listing is
 * verified deterministically.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
} from "../backend/openai-agents/models.js";
import {
  initOpenAIAgentsAgent,
  getOpenAIApiKey,
  getOpenAIBaseUrl,
} from "../backend/openai-agents/init.js";
import {
  getState,
  resetState,
  type EndpointModelCapabilities,
} from "../backend/openai-agents/state.js";

function seedCatalog(
  entries: Array<[string, EndpointModelCapabilities | undefined]>,
): void {
  const map = getState().endpointModels;
  map.clear();
  for (const [id, caps] of entries) {
    map.set(id, caps ?? {});
  }
}

beforeEach(() => resetState());
afterEach(() => resetState());

// ── resolveModel ────────────────────────────────────────────────────────────

describe("openai-agents / resolveModel", () => {
  it("returns missing for an empty query", () => {
    expect(resolveModel("").kind).toBe("missing");
    expect(resolveModel("   ").kind).toBe("missing");
  });

  it("exact-matches an advertised id and surfaces its metadata", () => {
    seedCatalog([
      ["gpt-5.5", { contextWindow: 400_000, displayName: "GPT-5.5" }],
    ]);
    const r = resolveModel("gpt-5.5");
    expect(r.kind).toBe("exact");
    if (r.kind !== "exact") return;
    expect(r.model.id).toBe("gpt-5.5");
    expect(r.model.contextWindow).toBe(400_000);
    expect(r.model.displayName).toBe("GPT-5.5");
    expect(r.storedValue).toBe("gpt-5.5");
  });

  it("prefix-matches by id when unambiguous", () => {
    seedCatalog([
      ["gpt-5-mini", { contextWindow: 200_000 }],
      ["o4-mini", { contextWindow: 128_000 }],
    ]);
    const r = resolveModel("gpt");
    expect(r.kind).toBe("exact");
    if (r.kind !== "exact") return;
    expect(r.model.id).toBe("gpt-5-mini");
  });

  it("returns ambiguous when more than one entry shares a prefix and none is an exact match", () => {
    seedCatalog([
      ["gpt-5.5", {}],
      ["gpt-5-mini", {}],
    ]);
    // "gpt-5" is a strict prefix of both ids but isn't an id itself,
    // so the resolver can't disambiguate.
    const r = resolveModel("gpt-5");
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.matches.map((m) => m.id).sort()).toEqual([
      "gpt-5-mini",
      "gpt-5.5",
    ]);
  });

  it("prefers exact id match even when there are longer-id prefix candidates", () => {
    seedCatalog([
      ["gpt-5", {}],
      ["gpt-5.5", {}],
      ["gpt-5-mini", {}],
    ]);
    // "gpt-5" is exact for the first entry; the resolver short-circuits
    // and doesn't go through the prefix ambiguity path.
    const r = resolveModel("gpt-5");
    expect(r.kind).toBe("exact");
    if (r.kind !== "exact") return;
    expect(r.model.id).toBe("gpt-5");
  });

  it("passes through unknown ids as bare passthrough models", () => {
    seedCatalog([]);
    const r = resolveModel("brand-new/release-2030");
    expect(r.kind).toBe("exact");
    if (r.kind !== "exact") return;
    expect(r.model.id).toBe("brand-new/release-2030");
    expect(r.model.displayName).toBe("brand-new/release-2030");
    expect(r.model.contextWindow).toBeUndefined();
    expect(r.model.provider).toBe("openai-compatible");
  });

  it("prefix-matches by display name when present", () => {
    seedCatalog([
      ["abc/owl-alpha", { displayName: "Owl Alpha", contextWindow: 1_000_000 }],
    ]);
    const r = resolveModel("owl");
    expect(r.kind).toBe("exact");
    if (r.kind !== "exact") return;
    expect(r.model.id).toBe("abc/owl-alpha");
  });
});

// ── getModelInfo ────────────────────────────────────────────────────────────

describe("openai-agents / getModelInfo", () => {
  it("returns enriched info for a known id", () => {
    seedCatalog([
      ["gpt-5.5", { contextWindow: 400_000, displayName: "GPT-5.5" }],
    ]);
    const info = getModelInfo("gpt-5.5");
    expect(info?.contextWindow).toBe(400_000);
    expect(info?.displayName).toBe("GPT-5.5");
  });

  it("returns a bare passthrough for an unknown id (never undefined for non-empty)", () => {
    seedCatalog([]);
    const info = getModelInfo("unknown/model");
    expect(info).toBeDefined();
    expect(info?.id).toBe("unknown/model");
    expect(info?.contextWindow).toBeUndefined();
    expect(info?.free).toBeUndefined();
  });

  it("returns undefined for the empty string", () => {
    expect(getModelInfo("")).toBeUndefined();
  });
});

// ── /settings presentation ──────────────────────────────────────────────────

describe("openai-agents / getSettingsPresentation", () => {
  it("marks the active model with a bullet and includes it first", () => {
    seedCatalog([
      ["gpt-5.5", { displayName: "GPT-5.5", contextWindow: 400_000 }],
      ["gpt-5", { displayName: "GPT-5", contextWindow: 400_000 }],
    ]);
    const pres = getSettingsPresentation("gpt-5.5");
    expect(pres.modelButtons[0].text).toContain("● ");
    expect(pres.modelButtons[0].callback_data).toBe("settings:model:gpt-5.5");
  });

  it("caps the visible button list to a sensible number", () => {
    const entries: Array<[string, EndpointModelCapabilities]> = [];
    for (let i = 0; i < 50; i++) entries.push([`m${i}`, {}]);
    seedCatalog(entries);
    const pres = getSettingsPresentation("m0");
    expect(pres.modelButtons.length).toBeLessThanOrEqual(12);
    expect(pres.modelButtons.length).toBeGreaterThan(0);
  });

  it("prefers entries with known context windows over bare passthroughs", () => {
    seedCatalog([
      ["bare", {}],
      ["enriched", { contextWindow: 128_000 }],
    ]);
    const pres = getSettingsPresentation("(unset)");
    // The enriched entry should appear ahead of the bare one
    const enrichedIdx = pres.modelButtons.findIndex((b) =>
      b.callback_data.endsWith("enriched"),
    );
    const bareIdx = pres.modelButtons.findIndex((b) =>
      b.callback_data.endsWith("bare"),
    );
    expect(enrichedIdx).toBeGreaterThanOrEqual(0);
    expect(bareIdx).toBeGreaterThanOrEqual(0);
    expect(enrichedIdx).toBeLessThan(bareIdx);
  });

  it("formats context window and free flag in details when present", () => {
    seedCatalog([["m", { contextWindow: 128_000, free: true }]]);
    const pres = getSettingsPresentation("m");
    expect(pres.modelDetails[0]).toContain("128k ctx");
    expect(pres.modelDetails[0]).toContain("free");
  });
});

// ── providers ──────────────────────────────────────────────────────────────

describe("openai-agents / providers", () => {
  it("exposes a single endpoint-agnostic provider", () => {
    seedCatalog([
      ["m1", {}],
      ["m2", {}],
    ]);
    const providers = getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("openai");
    expect(providers[0].modelCount).toBe(2);
  });

  it("paginates getProviderModels()", () => {
    const entries: Array<[string, EndpointModelCapabilities]> = [];
    for (let i = 0; i < 60; i++)
      entries.push([`m${String(i).padStart(2, "0")}`, {}]);
    seedCatalog(entries);
    const page1 = getProviderModels("openai", 1, 50);
    expect(page1.models.length).toBe(50);
    expect(page1.total).toBe(60);
    const page2 = getProviderModels("openai", 2, 50);
    expect(page2.models.length).toBe(10);
  });

  it("returns nothing for unknown providers", () => {
    seedCatalog([["m", {}]]);
    expect(getProviderModels("bogus").models).toEqual([]);
  });
});

// ── formatModelError ───────────────────────────────────────────────────────

describe("openai-agents / formatModelError", () => {
  it("lists the candidates on ambiguity", () => {
    seedCatalog([
      ["gpt-5", {}],
      ["gpt-5.5", {}],
    ]);
    const msg = formatModelError("gpt-5", {
      kind: "ambiguous",
      matches: [
        {
          id: "gpt-5",
          displayName: "x",
          provider: "x",
          providerName: "x",
          selectable: true,
          reasoning: false,
        },
        {
          id: "gpt-5.5",
          displayName: "x",
          provider: "x",
          providerName: "x",
          selectable: true,
          reasoning: false,
        },
      ],
    });
    expect(msg).toContain("gpt-5");
    expect(msg).toContain("gpt-5.5");
    expect(msg).toContain("Pick one");
  });

  it("returns the empty-query hint for `missing`", () => {
    const msg = formatModelError("", { kind: "missing" });
    expect(msg.toLowerCase()).toContain("no model id");
  });
});

// ── listModels filter ──────────────────────────────────────────────────────

describe("openai-agents / listModels", () => {
  it("returns the full catalog by default", () => {
    seedCatalog([
      ["m1", { free: true }],
      ["m2", {}],
      ["m3", { free: true }],
    ]);
    expect(listModels().models.length).toBe(3);
    expect(listModels("all").models.length).toBe(3);
  });

  it("returns only free-flagged models for the `free` filter", () => {
    seedCatalog([
      ["m-paid", {}],
      ["m-free", { free: true }],
    ]);
    const free = listModels("free");
    expect(free.models).toHaveLength(1);
    expect(free.models[0].id).toBe("m-free");
    expect(free.models[0].free).toBe(true);
  });

  it("returns an empty list when no entries are flagged free", () => {
    seedCatalog([["m", {}]]);
    expect(listModels("free").models).toEqual([]);
  });
});

// ── env-var resolution ─────────────────────────────────────────────────────

describe("openai-agents / env-var resolution", () => {
  const origTalonBase = process.env.TALON_AGENTS_URL;
  const origTalonKey = process.env.TALON_AGENTS_KEY;
  const origTalonMode = process.env.TALON_AGENTS_API_MODE;

  afterEach(() => {
    resetState();
    if (origTalonBase === undefined) delete process.env.TALON_AGENTS_URL;
    else process.env.TALON_AGENTS_URL = origTalonBase;
    if (origTalonKey === undefined) delete process.env.TALON_AGENTS_KEY;
    else process.env.TALON_AGENTS_KEY = origTalonKey;
    if (origTalonMode === undefined) delete process.env.TALON_AGENTS_API_MODE;
    else process.env.TALON_AGENTS_API_MODE = origTalonMode;
  });

  function init(cfg: { apiKey?: string; baseURL?: string }): void {
    delete process.env.TALON_AGENTS_URL;
    delete process.env.TALON_AGENTS_KEY;
    delete process.env.TALON_AGENTS_API_MODE;
    initOpenAIAgentsAgent(
      {
        model: "gpt-5.5",
        ...(cfg.apiKey ? { openaiApiKey: cfg.apiKey } : {}),
        ...(cfg.baseURL ? { openaiBaseUrl: cfg.baseURL } : {}),
      } as never,
      () => 12345,
      "telegram",
    );
  }

  it("returns the configured baseURL", () => {
    init({ apiKey: "k", baseURL: "https://openrouter.ai/api/v1" });
    expect(getOpenAIBaseUrl()).toBe("https://openrouter.ai/api/v1");
  });

  it("returns undefined when no baseURL is configured", () => {
    init({ apiKey: "k" });
    expect(getOpenAIBaseUrl()).toBeUndefined();
  });

  it("TALON_AGENTS_URL env overrides config", () => {
    init({ apiKey: "k", baseURL: "https://config.example.com/v1" });
    process.env.TALON_AGENTS_URL = "https://env.example.com/v1";
    expect(getOpenAIBaseUrl()).toBe("https://env.example.com/v1");
  });

  it("TALON_AGENTS_KEY env overrides config", () => {
    init({ apiKey: "config-key" });
    process.env.TALON_AGENTS_KEY = "env-key";
    expect(getOpenAIApiKey()).toBe("env-key");
  });
});
