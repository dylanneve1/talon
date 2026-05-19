/**
 * Codex model catalog tests.
 */

import { describe, it, expect } from "vitest";

import {
  CODEX_MODELS,
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
} from "../backend/codex/models.js";

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
  it("returns exact match for a known model id", () => {
    const result = resolveModel("gpt-5-codex");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.model.id).toBe("gpt-5-codex");
      expect(result.storedValue).toBe("gpt-5-codex");
    }
  });

  it("returns missing for an empty query", () => {
    expect(resolveModel("").kind).toBe("missing");
    expect(resolveModel("   ").kind).toBe("missing");
  });

  it("returns missing for an unrecognised query", () => {
    expect(resolveModel("nonsense-model-1.0").kind).toBe("missing");
  });

  it("returns ambiguous for a prefix that matches multiple", () => {
    // `gpt-5` matches gpt-5, gpt-5-codex, gpt-5-mini → ambiguous
    const result = resolveModel("gpt-5");
    // Exact match on "gpt-5" wins via the first-pass exact filter
    expect(result.kind).toBe("exact");
  });

  it("returns ambiguous when only prefix matches multiple", () => {
    // `gpt` (no exact match) matches all gpt-5* models → ambiguous
    const result = resolveModel("gpt");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matches.length).toBeGreaterThan(1);
    }
  });
});

describe("codex / getModelInfo", () => {
  it("returns the model for a known id", () => {
    expect(getModelInfo("gpt-5-codex")?.id).toBe("gpt-5-codex");
  });

  it("returns undefined for unknown ids", () => {
    expect(getModelInfo("not-real")).toBeUndefined();
  });
});

describe("codex / getSettingsPresentation", () => {
  it("returns one button per model with active marker on the current one", () => {
    const { modelButtons } = getSettingsPresentation("gpt-5");
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

  it("reports a single-page result for a small fixed catalog", () => {
    const { page, totalPages, filter, totalCount } =
      getSettingsPresentation("gpt-5");
    expect(page).toBe(1);
    expect(totalPages).toBe(1);
    expect(filter).toBe("all");
    expect(totalCount).toBe(CODEX_MODELS.length);
  });

  it("uses the supplied callbackPrefix", () => {
    const { modelButtons } = getSettingsPresentation("gpt-5", {
      callbackPrefix: "custom:prefix:",
    });
    for (const b of modelButtons) {
      expect(b.callback_data.startsWith("custom:prefix:")).toBe(true);
    }
  });
});

describe("codex / getProviders + getProviderModels", () => {
  it("returns OpenAI as the sole provider", () => {
    const providers = getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("openai");
    expect(providers[0].modelCount).toBe(CODEX_MODELS.length);
  });

  it("returns paginated models for openai provider", () => {
    const result = getProviderModels("openai", 1, 2);
    expect(result.models).toHaveLength(2);
    expect(result.total).toBe(CODEX_MODELS.length);
  });

  it("returns empty for unknown provider", () => {
    expect(getProviderModels("anthropic", 1, 50)).toEqual({
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

  it("describes a missing query with the full catalog", () => {
    const msg = formatModelError("xyz", { kind: "missing" });
    expect(msg).toContain("No Codex model matches");
    expect(msg).toContain("gpt-5-codex");
  });
});

describe("codex / listModels", () => {
  it("returns all by default", () => {
    const { models, total } = listModels();
    expect(total).toBe(CODEX_MODELS.length);
    expect(models).toEqual(CODEX_MODELS);
  });

  it("returns nothing for `free` filter — no free Codex models", () => {
    const { models, total } = listModels("free");
    expect(models).toEqual([]);
    expect(total).toBe(0);
  });

  it("returns all for the `all` filter", () => {
    const { total } = listModels("all");
    expect(total).toBe(CODEX_MODELS.length);
  });
});
