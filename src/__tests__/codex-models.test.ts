/**
 * Codex model catalog tests.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  CODEX_MODELS,
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
  getEffectiveModels,
  synthesizeUnknownModel,
} from "../backend/codex/models.js";
import { resetState, getState } from "../backend/codex/state.js";

beforeEach(() => {
  // Each test starts with a clean state (no in-flight discovery, empty
  // discovered set, no `discoveryAt`). The async model functions will
  // hit the early-return path in `awaitDiscovery` because no promise
  // is pending, so they resolve synchronously.
  resetState();
});

describe("codex / model catalog", () => {
  it("exposes at least the gpt-5-codex flagship", () => {
    expect(CODEX_MODELS.some((m) => m.id === "gpt-5-codex")).toBe(true);
  });

  it("every model carries the openai provider", () => {
    for (const m of CODEX_MODELS) {
      expect(m.provider).toBe("openai");
      expect(m.providerName).toBe("OpenAI");
      expect(m.selectable).toBe(true);
    }
  });
});

describe("codex / resolveModel", () => {
  it("returns exact match for a known model id", async () => {
    const result = await resolveModel("gpt-5-codex");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.model.id).toBe("gpt-5-codex");
      expect(result.storedValue).toBe("gpt-5-codex");
    }
  });

  it("returns missing for an empty query", async () => {
    expect((await resolveModel("")).kind).toBe("missing");
    expect((await resolveModel("   ")).kind).toBe("missing");
  });

  it("returns missing for an unrecognised query", async () => {
    expect((await resolveModel("nonsense-model-1.0")).kind).toBe("missing");
  });

  it("returns exact for `gpt-5` because exact-id wins over prefix", async () => {
    const result = await resolveModel("gpt-5");
    expect(result.kind).toBe("exact");
  });

  it("returns ambiguous when only prefix matches multiple", async () => {
    const result = await resolveModel("gpt");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matches.length).toBeGreaterThan(1);
    }
  });

  it("resolves a discovered-only model id when curated catalog doesn't list it", async () => {
    getState().discoveredModels.add("gpt-6-preview");
    const result = await resolveModel("gpt-6-preview");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.model.id).toBe("gpt-6-preview");
      expect(result.model.displayName).toBe("GPT-6-preview");
    }
  });
});

describe("codex / getModelInfo", () => {
  it("returns the model for a known id", async () => {
    expect((await getModelInfo("gpt-5-codex"))?.id).toBe("gpt-5-codex");
  });

  it("returns undefined for unknown ids", async () => {
    expect(await getModelInfo("not-real")).toBeUndefined();
  });

  it("returns a discovered-only id with synthesised metadata", async () => {
    getState().discoveredModels.add("o5-mini");
    const info = await getModelInfo("o5-mini");
    expect(info?.id).toBe("o5-mini");
    expect(info?.reasoning).toBe(true);
  });
});

describe("codex / getSettingsPresentation", () => {
  it("returns one button per curated model with active marker on the current one", async () => {
    const { modelButtons } = await getSettingsPresentation("gpt-5");
    expect(modelButtons).toHaveLength(CODEX_MODELS.length);

    const active = modelButtons.find((b) => b.callback_data.endsWith("gpt-5"));
    const others = modelButtons.filter(
      (b) => !b.callback_data.endsWith("gpt-5"),
    );
    expect(active?.text).toMatch(/^●/);
    for (const b of others) {
      expect(b.text).not.toMatch(/^●/);
    }
  });

  it("reports a single-page result for the curated fallback", async () => {
    const { page, totalPages, filter, totalCount } =
      await getSettingsPresentation("gpt-5");
    expect(page).toBe(1);
    expect(totalPages).toBe(1);
    expect(filter).toBe("all");
    expect(totalCount).toBe(CODEX_MODELS.length);
  });

  it("uses the supplied callbackPrefix", async () => {
    const { modelButtons } = await getSettingsPresentation("gpt-5", {
      callbackPrefix: "custom:prefix:",
    });
    for (const b of modelButtons) {
      expect(b.callback_data.startsWith("custom:prefix:")).toBe(true);
    }
  });

  it("labels the catalog source as curated when discovery is empty", async () => {
    const { modelDetails } = await getSettingsPresentation("gpt-5");
    expect(modelDetails.join("\n")).toMatch(/curated/);
  });

  it("labels the catalog source as discovered when /v1/models returned ids", async () => {
    const state = getState();
    state.discoveredModels.add("gpt-5.5");
    state.discoveredModels.add("gpt-5");
    state.discoveryAt = Date.now();
    const { modelDetails } = await getSettingsPresentation("gpt-5.5");
    expect(modelDetails.join("\n")).toMatch(/discovered/);
  });
});

describe("codex / getProviders + getProviderModels", () => {
  it("returns OpenAI as the sole provider", async () => {
    const providers = await getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("openai");
    expect(providers[0].modelCount).toBe(CODEX_MODELS.length);
  });

  it("returns paginated models for openai provider", async () => {
    const result = await getProviderModels("openai", 1, 2);
    expect(result.models).toHaveLength(2);
    expect(result.total).toBe(CODEX_MODELS.length);
  });

  it("returns empty for unknown provider", async () => {
    expect(await getProviderModels("anthropic", 1, 50)).toEqual({
      models: [],
      total: 0,
    });
  });
});

describe("codex / formatModelError", () => {
  it("describes ambiguous matches with backtick-quoted ids", () => {
    const msg = formatModelError("gpt", {
      kind: "ambiguous",
      matches: CODEX_MODELS.filter((m) => m.id.startsWith("gpt-5")),
    });
    expect(msg).toContain("Multiple Codex models match");
    expect(msg).toContain("`gpt-5-codex`");
  });

  it("describes a missing query with the effective catalog", () => {
    const msg = formatModelError("xyz", { kind: "missing" });
    expect(msg).toContain("No Codex model matches");
    expect(msg).toContain("gpt-5-codex");
  });
});

describe("codex / listModels", () => {
  it("returns all curated by default when discovery is empty", async () => {
    const { models, total } = await listModels();
    expect(total).toBe(CODEX_MODELS.length);
    expect(models.map((m) => m.id)).toEqual(CODEX_MODELS.map((m) => m.id));
  });

  it("returns nothing for `free` filter — no free Codex models", async () => {
    const { models, total } = await listModels("free");
    expect(models).toEqual([]);
    expect(total).toBe(0);
  });

  it("returns all for the `all` filter", async () => {
    const { total } = await listModels("all");
    expect(total).toBe(CODEX_MODELS.length);
  });
});

describe("codex / getEffectiveModels (merge logic)", () => {
  it("returns the curated catalog when no discovery has happened", () => {
    const catalog = getEffectiveModels();
    expect(catalog.map((m) => m.id)).toEqual(CODEX_MODELS.map((m) => m.id));
  });

  it("filters curated entries by discovered set when discovery succeeded", () => {
    const state = getState();
    state.discoveredModels.add("gpt-5.5");
    state.discoveredModels.add("gpt-5");
    state.discoveryAt = Date.now();

    const catalog = getEffectiveModels();
    expect(catalog.map((m) => m.id).sort()).toEqual(["gpt-5", "gpt-5.5"]);
    // Curated metadata survives — apiKeyOnly remains absent on gpt-5
    expect(catalog.find((m) => m.id === "gpt-5")?.contextWindow).toBe(400_000);
  });

  it("synthesises entries for discovered ids not in the curated table", () => {
    const state = getState();
    state.discoveredModels.add("gpt-6-preview"); // not in curated
    state.discoveryAt = Date.now();

    const catalog = getEffectiveModels();
    expect(catalog.map((m) => m.id)).toEqual(["gpt-6-preview"]);
    expect(catalog[0].displayName).toBe("GPT-6-preview");
    expect(catalog[0].provider).toBe("openai");
    expect(catalog[0].selectable).toBe(true);
  });

  it("orders curated entries first, then discovered-only entries", () => {
    const state = getState();
    state.discoveredModels.add("gpt-5.5");
    state.discoveredModels.add("gpt-6-preview");
    state.discoveryAt = Date.now();

    const catalog = getEffectiveModels();
    expect(catalog.map((m) => m.id)).toEqual(["gpt-5.5", "gpt-6-preview"]);
  });

  it("preserves apiKeyOnly metadata from curated entries", () => {
    const state = getState();
    state.discoveredModels.add("gpt-5-codex");
    state.discoveryAt = Date.now();

    const catalog = getEffectiveModels();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe("gpt-5-codex");
    // apiKeyOnly is what the recovery ladder reads — must survive the merge
    const codex = catalog[0] as { apiKeyOnly?: boolean };
    expect(codex.apiKeyOnly).toBe(true);
  });
});

describe("codex / synthesizeUnknownModel", () => {
  it("derives a display name from the id", () => {
    expect(synthesizeUnknownModel("gpt-6").displayName).toBe("GPT-6");
    expect(synthesizeUnknownModel("chatgpt-5-latest").displayName).toBe(
      "ChatGPT-5-latest",
    );
  });

  it("flags reasoning models (o3*/o4*/-codex)", () => {
    expect(synthesizeUnknownModel("o5-mini").reasoning).toBe(true);
    expect(synthesizeUnknownModel("o3-pro").reasoning).toBe(true);
    expect(synthesizeUnknownModel("gpt-6-codex").reasoning).toBe(true);
  });

  it("does not flag plain chat models as reasoning", () => {
    expect(synthesizeUnknownModel("gpt-4.1").reasoning).toBe(false);
    expect(synthesizeUnknownModel("chatgpt-4o-latest").reasoning).toBe(false);
  });
});
