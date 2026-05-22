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

  it("passes through discovered reasoning levels", () => {
    seedCatalog([
      [
        "gpt-5.5",
        {
          supportedReasoningLevels: ["minimal", "low", "high"],
          defaultReasoningLevel: "low",
        },
      ],
    ]);
    const info = getModelInfo("gpt-5.5");
    expect(info?.reasoning).toBe(true);
    expect(info?.supportedReasoningLevels).toEqual(["minimal", "low", "high"]);
    expect(info?.defaultReasoningLevel).toBe("low");
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

describe("openai-agents / getSettingsPresentation — small catalog (flat view)", () => {
  it('returns view="models" with the active model bullet-marked', async () => {
    seedCatalog([
      ["gpt-5.5", { displayName: "GPT-5.5", contextWindow: 400_000 }],
      ["gpt-5", { displayName: "GPT-5", contextWindow: 400_000 }],
    ]);
    const pres = await getSettingsPresentation("gpt-5.5");
    expect(pres.view).toBe("models");
    const activeBtn = pres.modelButtons.find((b) =>
      b.callback_data.endsWith("gpt-5.5"),
    );
    expect(activeBtn?.text.startsWith("● ")).toBe(true);
    expect(activeBtn?.callback_data).toBe("settings:model:gpt-5.5");
  });

  it("paginates correctly", async () => {
    const entries: Array<[string, EndpointModelCapabilities]> = [];
    for (let i = 0; i < 25; i++)
      entries.push([`m${String(i).padStart(2, "0")}`, {}]);
    seedCatalog(entries);
    const page1 = await getSettingsPresentation("m00", { pageSize: 8 });
    const page2 = await getSettingsPresentation("m00", {
      pageSize: 8,
      page: 2,
    });
    expect(page1.view).toBe("models");
    expect(page1.page).toBe(1);
    expect(page2.page).toBe(2);
    expect(page1.modelButtons).not.toEqual(page2.modelButtons);
    expect(page1.totalPages).toBe(Math.ceil(25 / 8));
  });

  it("clamps page > totalPages to the last page", async () => {
    const entries: Array<[string, EndpointModelCapabilities]> = [];
    for (let i = 0; i < 12; i++) entries.push([`m${i}`, {}]);
    seedCatalog(entries);
    const pres = await getSettingsPresentation("m0", {
      pageSize: 4,
      page: 999,
    });
    expect(pres.page).toBe(3);
    expect(pres.totalPages).toBe(3);
  });

  it("applies the free filter and reports freeCount as a hint", async () => {
    seedCatalog([
      ["paid-a", {}],
      ["paid-b", {}],
      ["free-a", { free: true }],
      ["free-b", { free: true }],
    ]);
    const all = await getSettingsPresentation("(none)");
    expect(all.freeCount).toBe(2);
    expect(all.totalCount).toBe(4);
    const free = await getSettingsPresentation("(none)", { filter: "free" });
    expect(free.filter).toBe("free");
    expect(free.modelButtons).toHaveLength(2);
    for (const b of free.modelButtons) {
      expect(b.callback_data).toMatch(/free-/);
    }
  });

  it("modelDetails carries plain-text backend status (no markup)", async () => {
    seedCatalog([["m1", { contextWindow: 128_000, free: true }]]);
    const pres = await getSettingsPresentation("m1");
    for (const line of pres.modelDetails) {
      expect(line).not.toContain("<b>");
      expect(line).not.toContain("**");
      expect(line).not.toContain("`");
    }
    expect(pres.modelDetails.some((l) => /discovered/.test(l))).toBe(true);
  });

  it("button labels strip vendor prefix and surface ctx + free flag", async () => {
    seedCatalog([
      ["openrouter/owl-alpha", { contextWindow: 1_000_000, free: true }],
    ]);
    const pres = await getSettingsPresentation("(none)");
    const btn = pres.modelButtons[0];
    expect(btn.text).toContain("owl-alpha");
    expect(btn.text).not.toContain("openrouter/");
    expect(btn.text).toMatch(/1M/);
    expect(btn.text).toContain("🆓");
  });

  it("hides models whose `<prefix><id>` would overflow Telegram's 64-byte callback_data limit", async () => {
    // 61-char id + `model:` (6) = 67 bytes — over Telegram's limit.
    // OpenRouter ships exactly one such id today
    // (`cognitivecomputations/dolphin-mistral-24b-venice-edition:free`),
    // which crashed BUTTON_DATA_INVALID before this guard.
    const overflow = "a".repeat(61);
    const ok = "short-id";
    seedCatalog([
      [overflow, { contextWindow: 8192 }],
      [ok, { contextWindow: 8192 }],
    ]);
    const pres = await getSettingsPresentation("(none)", {
      callbackPrefix: "model:",
    });
    for (const b of pres.modelButtons) {
      expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(
        64,
      );
    }
    expect(pres.modelButtons.some((b) => b.callback_data.endsWith(ok))).toBe(
      true,
    );
    expect(
      pres.modelButtons.some((b) => b.callback_data.includes(overflow)),
    ).toBe(false);
    // The totalCount reflects what's *renderable*, not the raw catalog,
    // so /status and the menu status line don't lie about visibility.
    expect(pres.totalCount).toBe(1);
  });
});

describe("openai-agents / getSettingsPresentation — large catalog (provider groups)", () => {
  function seedLarge(): void {
    // Build a 60-model catalog spread across 4 providers — well over
    // the 30-model PROVIDER_GROUP_THRESHOLD.
    const entries: Array<[string, EndpointModelCapabilities]> = [];
    for (let i = 0; i < 20; i++)
      entries.push([`anthropic/m${i}`, { contextWindow: 200_000 }]);
    for (let i = 0; i < 15; i++)
      entries.push([`openai/m${i}`, { contextWindow: 400_000 }]);
    for (let i = 0; i < 15; i++)
      entries.push([`google/m${i}`, { contextWindow: 1_000_000 }]);
    for (let i = 0; i < 10; i++)
      entries.push([`mistralai/m${i}`, { contextWindow: 64_000 }]);
    seedCatalog(entries);
  }

  it('returns view="groups" with provider chips when no provider is selected', async () => {
    seedLarge();
    const pres = await getSettingsPresentation("(none)");
    expect(pres.view).toBe("groups");
    expect(pres.modelButtons.length).toBe(4); // anthropic / openai / google / mistralai
    expect(pres.modelButtons[0].text).toMatch(/\((\d+)\)/);
  });

  it("provider buttons carry a `:provider:` drill callback under the default navPrefix", async () => {
    seedLarge();
    const pres = await getSettingsPresentation("(none)");
    for (const b of pres.modelButtons) {
      expect(b.callback_data).toMatch(/^settings:models:provider:/);
    }
  });

  it("honors an explicit navCallbackPrefix", async () => {
    seedLarge();
    const pres = await getSettingsPresentation("(none)", {
      callbackPrefix: "model:",
      navCallbackPrefix: "model:nav",
    });
    for (const b of pres.modelButtons) {
      expect(b.callback_data).toMatch(/^model:nav:provider:/);
    }
  });

  it("drills into a provider via options.provider", async () => {
    seedLarge();
    const pres = await getSettingsPresentation("(none)", {
      provider: "google",
    });
    expect(pres.view).toBe("models");
    expect(pres.provider).toBe("google");
    for (const b of pres.modelButtons) {
      expect(b.callback_data).toMatch(/settings:model:google\//);
    }
  });

  it("skips the group view when the filtered catalog is small (free filter)", async () => {
    // Only one free model — under the threshold even before grouping.
    const entries: Array<[string, EndpointModelCapabilities]> = [];
    for (let i = 0; i < 40; i++)
      entries.push([`p/m${i}`, { contextWindow: 100_000 }]);
    entries.push(["free/only", { free: true, contextWindow: 50_000 }]);
    seedCatalog(entries);
    const pres = await getSettingsPresentation("(none)", { filter: "free" });
    expect(pres.view).toBe("models");
    expect(pres.modelButtons).toHaveLength(1);
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

// ── Provider grouping with flat ids ────────────────────────────────────────
//
// Sparse endpoints like Zen and OpenAI itself return flat model ids
// without a `vendor/` prefix. Bucketing those by string-before-slash
// dumps everything into a single bin and makes the picker useless.
// The provider-inference table must recognise the family prefix.

describe("openai-agents / picker / flat-id provider inference", () => {
  it("groups Zen-style flat ids by inferred provider", async () => {
    const entries: Array<[string, EndpointModelCapabilities]> = [];
    // Zen catalog sample — 8 anthropic, 8 openai, 2 google, 1 meta,
    // 1 nvidia, etc. → 31 entries, exceeds the 30-entry grouping
    // threshold, so the picker should produce provider chips.
    for (const id of [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-sonnet-4",
      "claude-haiku-4-5",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4",
      "gpt-5-codex",
      "gpt-5-nano",
      "o1",
      "o3-mini",
      "o4",
      "gemini-3.1-pro",
      "gemini-3-flash",
      "gemma-3-27b",
      "llama-3.3-70b",
      "codellama-70b",
      "phi-4-mini",
      "deepseek-v4-flash-free",
      "deepseek-v4-pro",
      "qwen3.6-plus",
      "qwen3.5-plus",
      "kimi-k2.6",
      "kimi-k2.5",
      "glm-5.1",
      "glm-5",
      "minimax-m2.7",
      "minimax-m2.5",
      "nemotron-3-super-free",
      "mistral-large-3",
      "grok-4",
      "big-pickle",
    ]) {
      entries.push([id, {}]);
    }
    seedCatalog(entries);
    const pres = await getSettingsPresentation("(none)");
    expect(pres.view).toBe("groups");
    const labels = pres.modelButtons.map((b: { text: string }) => b.text);
    // Should NOT lump them all into a single bucket.
    expect(labels.length).toBeGreaterThan(5);
    // Spot-check the known families show up with sensible names.
    const joined = labels.join(" | ");
    expect(joined).toMatch(/Anthropic/);
    expect(joined).toMatch(/OpenAI/);
    expect(joined).toMatch(/Google/);
    expect(joined).toMatch(/NVIDIA|Nvidia/);
    expect(joined).toMatch(/DeepSeek/);
    expect(joined).toMatch(/MiniMax|Minimax/);
  });

  it("drilling into a provider returns only that family's models", async () => {
    const entries: Array<[string, EndpointModelCapabilities]> = [
      ["claude-opus-4-7", {}],
      ["claude-sonnet-4", {}],
      ["gpt-5.5", {}],
      ["gemini-3-flash", {}],
    ];
    seedCatalog(entries);
    const pres = await getSettingsPresentation("(none)", {
      provider: "anthropic",
    });
    expect(pres.view).toBe("models");
    expect(pres.modelButtons.map((b: { text: string }) => b.text)).toEqual(
      expect.arrayContaining([expect.stringMatching(/claude-opus/)]),
    );
    for (const b of pres.modelButtons) {
      expect(b.text).toMatch(/claude/);
    }
  });

  it("vendor/model ids still resolve via the slash prefix", async () => {
    const entries: Array<[string, EndpointModelCapabilities]> = [];
    for (let i = 0; i < 35; i++) entries.push([`anthropic/c-${i}`, {}]);
    seedCatalog(entries);
    const pres = await getSettingsPresentation("(none)");
    expect(pres.view).toBe("groups");
    expect(pres.modelButtons.map((b: { text: string }) => b.text)).toEqual([
      expect.stringMatching(/^Anthropic \(35\)$/),
    ]);
  });

  it("unknown flat ids fall into an 'Other' bucket — not 'OpenAI'", async () => {
    const entries: Array<[string, EndpointModelCapabilities]> = [];
    for (let i = 0; i < 35; i++) entries.push([`whatever-${i}`, {}]);
    seedCatalog(entries);
    const pres = await getSettingsPresentation("(none)");
    expect(pres.view).toBe("groups");
    expect(pres.modelButtons[0].text).toMatch(/^Other/);
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
