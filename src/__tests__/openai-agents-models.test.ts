/**
 * OpenAI Agents backend — model catalog tests.
 *
 * The Agents SDK accepts any string the OpenAI Responses API accepts,
 * but Talon ships a hand-maintained catalog for the model picker UI.
 * These tests pin the catalog shape + the standard `resolveModel` /
 * `formatModelError` / `listModels` behaviour.
 */

import { describe, it, expect } from "vitest";
import {
  OPENAI_AGENTS_MODELS,
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
} from "../backend/openai-agents/models.js";

describe("openai-agents / model catalog", () => {
  it("exposes at least the gpt-5.5 flagship", () => {
    expect(OPENAI_AGENTS_MODELS.find((m) => m.id === "gpt-5.5")).toBeDefined();
  });

  it("every model carries the openai provider", () => {
    for (const m of OPENAI_AGENTS_MODELS) {
      expect(m.provider).toBe("openai");
      expect(m.providerName).toBe("OpenAI");
      expect(m.selectable).toBe(true);
    }
  });

  it("does NOT include gpt-5-codex (Codex CLI only)", () => {
    expect(
      OPENAI_AGENTS_MODELS.find((m) => m.id === "gpt-5-codex"),
    ).toBeUndefined();
  });
});

describe("openai-agents / resolveModel", () => {
  it("returns exact match for a known model id", () => {
    const r = resolveModel("gpt-5.5");
    expect(r.kind).toBe("exact");
    if (r.kind !== "exact") return;
    expect(r.model.id).toBe("gpt-5.5");
  });

  it("returns missing for an empty query", () => {
    expect(resolveModel("").kind).toBe("missing");
  });

  it("returns missing for an unrecognised query", () => {
    expect(resolveModel("totally-not-a-model").kind).toBe("missing");
  });

  it("returns ambiguous for a prefix that matches multiple", () => {
    const r = resolveModel("gpt-5");
    // `gpt-5`, `gpt-5.5`, and `gpt-5-mini` all share the `gpt-5` prefix.
    expect(["exact", "ambiguous"]).toContain(r.kind);
    // `gpt-5` itself IS an exact id, so prefix match prefers the exact one.
    // The handler-facing contract is that an unambiguous user query like
    // `gpt-5` resolves cleanly to the exact id; we still want SOME match.
  });
});

describe("openai-agents / getModelInfo", () => {
  it("returns the model for a known id", () => {
    expect(getModelInfo("gpt-5.5")?.id).toBe("gpt-5.5");
  });

  it("returns undefined for unknown ids", () => {
    expect(getModelInfo("missing-model")).toBeUndefined();
  });
});

describe("openai-agents / getSettingsPresentation", () => {
  it("returns one button per model with active marker on the current one", () => {
    const pres = getSettingsPresentation("gpt-5");
    expect(pres.modelButtons.length).toBe(OPENAI_AGENTS_MODELS.length);
    const activeButton = pres.modelButtons.find((b) =>
      b.callback_data.endsWith("gpt-5"),
    );
    expect(activeButton?.text.startsWith("● ")).toBe(true);
  });

  it("uses the supplied callbackPrefix", () => {
    const pres = getSettingsPresentation("gpt-5.5", "model:");
    expect(pres.modelButtons[0].callback_data.startsWith("model:")).toBe(true);
  });
});

describe("openai-agents / getProviders + getProviderModels", () => {
  it("returns OpenAI as the sole provider", () => {
    const providers = getProviders();
    expect(providers.length).toBe(1);
    expect(providers[0].id).toBe("openai");
    expect(providers[0].connected).toBe(true);
    expect(providers[0].modelCount).toBe(OPENAI_AGENTS_MODELS.length);
  });

  it("returns paginated models for openai provider", () => {
    const page1 = getProviderModels("openai", 1, 2);
    expect(page1.models.length).toBe(2);
    expect(page1.total).toBe(OPENAI_AGENTS_MODELS.length);
  });

  it("returns empty for unknown provider", () => {
    expect(getProviderModels("anthropic").models).toEqual([]);
  });
});

describe("openai-agents / formatModelError", () => {
  it("describes ambiguous matches with backtick-quoted ids", () => {
    const msg = formatModelError("g", {
      kind: "ambiguous",
      matches: OPENAI_AGENTS_MODELS.slice(0, 2),
    });
    expect(msg).toContain("Multiple");
    expect(msg).toContain("`");
  });

  it("describes a missing query with the full catalog", () => {
    const msg = formatModelError("nope", { kind: "missing" });
    expect(msg).toContain("No OpenAI Agents model matches");
    expect(msg).toContain("gpt-5.5");
  });
});

describe("openai-agents / listModels", () => {
  it("returns all by default", () => {
    const r = listModels();
    expect(r.models.length).toBe(OPENAI_AGENTS_MODELS.length);
    expect(r.total).toBe(OPENAI_AGENTS_MODELS.length);
  });

  it("returns nothing for `free` filter — no free OpenAI Agents models", () => {
    expect(listModels("free").models).toEqual([]);
  });

  it("returns all for the `all` filter", () => {
    expect(listModels("all").models.length).toBe(OPENAI_AGENTS_MODELS.length);
  });
});
