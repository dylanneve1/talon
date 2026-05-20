/**
 * Antigravity model catalog tests.
 */

import { describe, it, expect } from "vitest";

import {
  ANTIGRAVITY_MODELS,
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
} from "../backend/antigravity/models.js";

describe("antigravity / model catalog", () => {
  it("exposes Gemini 3.5 Flash as the default candidate", () => {
    // Catalog ids now use the canonical `models/<x>` form returned by
    // Gemini's `models.list` API. Fallback list mirrors that.
    expect(
      ANTIGRAVITY_MODELS.some((m) => m.id === "models/gemini-3.5-flash"),
    ).toBe(true);
  });

  it("includes the Pro variant", () => {
    expect(ANTIGRAVITY_MODELS.some((m) => m.id === "models/gemini-3-pro")).toBe(
      true,
    );
  });

  it("every model carries the google provider", () => {
    for (const m of ANTIGRAVITY_MODELS) {
      expect(m.provider).toBe("google");
      expect(m.providerName).toBe("Google");
      expect(m.selectable).toBe(true);
      expect(m.reasoning).toBe(true);
    }
  });

  it("context windows are all >= 1M tokens", () => {
    for (const m of ANTIGRAVITY_MODELS) {
      expect((m.contextWindow ?? 0) >= 1_000_000).toBe(true);
    }
  });
});

describe("antigravity / resolveModel", () => {
  it("returns exact match for the canonical model id", () => {
    const result = resolveModel("models/gemini-3.5-flash");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.model.id).toBe("models/gemini-3.5-flash");
      expect(result.storedValue).toBe("models/gemini-3.5-flash");
    }
  });

  it("returns exact match for the bare model id (back-compat)", () => {
    // v0 of the catalog stored bare ids like `gemini-3.5-flash`.
    // The new resolver accepts both forms so stored chat-settings
    // from before the dynamic-catalog change keep working.
    const result = resolveModel("gemini-3.5-flash");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.model.id).toBe("models/gemini-3.5-flash");
    }
  });

  it("returns missing for unknown queries", () => {
    expect(resolveModel("claude-opus").kind).toBe("missing");
  });

  it("returns missing for empty query", () => {
    expect(resolveModel("").kind).toBe("missing");
    expect(resolveModel("   ").kind).toBe("missing");
  });

  it("matches by case-insensitive prefix on id", () => {
    const result = resolveModel("GEMINI-3.5-FL");
    expect(["exact", "ambiguous"]).toContain(result.kind);
  });

  it("returns ambiguous on a multi-match prefix", () => {
    // "gemini-3" matches both gemini-3-pro and gemini-3.5-* by prefix.
    const result = resolveModel("gemini-3");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matches.length).toBeGreaterThan(1);
    }
  });
});

describe("antigravity / getModelInfo", () => {
  it("returns the model entry for the canonical id", () => {
    const m = getModelInfo("models/gemini-3.5-flash");
    expect(m?.displayName).toBe("Gemini 3.5 Flash");
  });

  it("returns the model entry for the bare id (back-compat)", () => {
    const m = getModelInfo("gemini-3.5-flash");
    expect(m?.displayName).toBe("Gemini 3.5 Flash");
  });

  it("returns undefined for an unknown id", () => {
    expect(getModelInfo("not-a-model")).toBeUndefined();
  });
});

describe("antigravity / getSettingsPresentation", () => {
  it("marks the active model with a bullet", () => {
    const res = getSettingsPresentation("models/gemini-3.5-flash");
    const active = res.modelButtons.find((b) => b.text.startsWith("● "));
    expect(active?.text).toContain("Gemini 3.5 Flash");
  });

  it("reports the model count in details", () => {
    const res = getSettingsPresentation("models/gemini-3.5-flash");
    expect(res.modelDetails.some((d) => d.includes("Antigravity"))).toBe(true);
  });

  it("returns view: models", () => {
    expect(getSettingsPresentation("models/gemini-3.5-flash").view).toBe(
      "models",
    );
  });

  it("uses callbackPrefix when supplied", () => {
    const res = getSettingsPresentation("models/gemini-3.5-flash", {
      callbackPrefix: "test:",
    });
    for (const b of res.modelButtons) {
      expect(b.callback_data.startsWith("test:")).toBe(true);
    }
  });
});

describe("antigravity / getProviders + getProviderModels", () => {
  it("lists Google as the only provider", () => {
    const providers = getProviders();
    expect(providers.length).toBe(1);
    expect(providers[0].id).toBe("google");
    expect(providers[0].connected).toBe(true);
  });

  it("returns models for the google provider", () => {
    const { models, total } = getProviderModels("google");
    expect(models.length).toBe(total);
    expect(models.length).toBe(ANTIGRAVITY_MODELS.length);
  });

  it("returns empty for an unknown provider", () => {
    const { models, total } = getProviderModels("anthropic");
    expect(models).toEqual([]);
    expect(total).toBe(0);
  });

  it("supports pagination", () => {
    const page1 = getProviderModels("google", 1, 2);
    const page2 = getProviderModels("google", 2, 2);
    expect(page1.models.length).toBe(2);
    expect(page2.total).toBe(ANTIGRAVITY_MODELS.length);
    // Pages don't overlap.
    expect(page1.models[0].id).not.toBe(page2.models[0]?.id);
  });
});

describe("antigravity / formatModelError", () => {
  it("formats an ambiguous query with the matching ids", () => {
    const r = resolveModel("gemini-3");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      const msg = formatModelError("gemini-3", r);
      expect(msg).toContain("Multiple");
      expect(msg).toContain("gemini-3");
    }
  });

  it("formats a missing query with a sample of the catalog", () => {
    const r = resolveModel("nope");
    const msg = formatModelError("nope", r);
    expect(msg).toContain("No Antigravity model matches");
    expect(msg.toLowerCase()).toContain("gemini-3.5-flash");
  });
});

describe("antigravity / listModels", () => {
  it("returns the full catalog with no filter", () => {
    const { models, total } = listModels();
    expect(total).toBe(ANTIGRAVITY_MODELS.length);
    expect(models.length).toBe(total);
  });

  it("free filter returns an empty list (Gemini API gating depends on billing)", () => {
    const { models, total } = listModels("free");
    expect(models).toEqual([]);
    expect(total).toBe(0);
  });

  it("all filter returns the full catalog", () => {
    const { models, total } = listModels("all");
    expect(total).toBe(ANTIGRAVITY_MODELS.length);
    expect(models.length).toBe(total);
  });
});
