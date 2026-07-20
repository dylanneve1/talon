import { describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// ensureServer is reached transitively through getOpenCodeModelCatalog if it's
// ever invoked. We don't invoke it here — these tests use a hand-built catalog
// against resolveOpenCodeModelInput / getOpenCodeModelSelectionValue — but the
// kilo server module still gets imported for type resolution. Stub it so the
// import doesn't try to spin up a real Kilo process.
vi.mock("../backend/kilo/server.js", () => ({
  onServerStop: vi.fn(),
  ensureServer: vi.fn(async () => {
    throw new Error("ensureServer should not be called from kilo-models tests");
  }),
  getConfig: vi.fn(() => undefined),
  initKiloAgent: vi.fn(),
  stopKiloServer: vi.fn(),
}));

const { getOpenCodeModelSelectionValue, resolveOpenCodeModelInput } =
  await import("../backend/kilo/index.js");

type Entry = Parameters<typeof getOpenCodeModelSelectionValue>[0];

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "default-id",
    name: "Default",
    providerID: "p",
    providerName: "P",
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

const sharedModels = [
  makeEntry({
    id: "gpt-5",
    name: "GPT-5",
    providerID: "openai",
    providerName: "OpenAI",
    connected: false,
    selectable: false,
    loginRequired: true,
    authMethods: ["OAuth"],
    contextWindow: 400_000,
    reasoning: true,
  }),
  makeEntry({
    id: "gpt-5",
    name: "GPT-5",
    providerID: "github-copilot",
    providerName: "GitHub Copilot",
    contextWindow: 400_000,
    reasoning: true,
  }),
  makeEntry({
    id: "big-pickle",
    name: "Big Pickle",
    providerID: "kilo",
    providerName: "Kilo",
    free: true,
    costInput: 0,
    costOutput: 0,
    contextWindow: 200_000,
    reasoning: true,
  }),
  // Kilo IDs frequently embed both "/" and ":" — this is the exact case the
  // fast-path in resolveOpenCodeModelInput exists to catch.
  makeEntry({
    id: "inclusionai/ling-2.6-1t:free",
    name: "Ling 2.6 1T (Free)",
    providerID: "openrouter",
    providerName: "OpenRouter",
    free: true,
    costInput: 0,
    costOutput: 0,
    contextWindow: 128_000,
  }),
] satisfies Entry[];

const catalog = {
  generatedAt: Date.now(),
  providers: [],
  connectedProviders: [],
  loginProviders: [],
  connectedModels: [],
  connectedFreeModels: [],
  models: sharedModels,
};

describe("Kilo model resolution", () => {
  it("resolves provider-qualified model queries exactly", () => {
    const resolution = resolveOpenCodeModelInput(
      "github-copilot/gpt-5",
      catalog as any,
    );

    expect(resolution.kind).toBe("exact");
    if (resolution.kind !== "exact") return;
    expect(resolution.model.providerID).toBe("github-copilot");
  });

  it("uses provider-qualified storage values only for colliding model ids", () => {
    const duplicateValue = getOpenCodeModelSelectionValue(
      sharedModels[0],
      catalog as any,
    );
    const uniqueValue = getOpenCodeModelSelectionValue(
      sharedModels[2],
      catalog as any,
    );

    expect(duplicateValue).toBe("openai/gpt-5");
    expect(uniqueValue).toBe("big-pickle");
  });

  // ── Kilo-specific regression catcher ─────────────────────────────────────
  // Without the full-ID fast path, "inclusionai/ling-2.6-1t:free" would be
  // split into providerQuery="inclusionai", modelQuery="ling-2.6-1t:free",
  // and the ":free" suffix would never produce a clean exact hit. The fast
  // path in models.ts short-circuits this by trying the trimmed query as a
  // literal model.id first.
  it("matches a full Kilo ID containing both / and : via the fast path", () => {
    const resolution = resolveOpenCodeModelInput(
      "inclusionai/ling-2.6-1t:free",
      catalog as any,
    );

    expect(resolution.kind).toBe("exact");
    if (resolution.kind !== "exact") return;
    expect(resolution.model.id).toBe("inclusionai/ling-2.6-1t:free");
    expect(resolution.model.providerID).toBe("openrouter");
  });

  it("returns missing for queries that match nothing", () => {
    const resolution = resolveOpenCodeModelInput(
      "nonexistent-model-xyz",
      catalog as any,
    );

    expect(resolution.kind).toBe("missing");
  });

  it("returns an exact resolution when only one match exists, even if not selectable", () => {
    // OpenAI's gpt-5 entry is loginRequired (not selectable). But when the
    // query is provider-qualified to "openai/gpt-5", there's exactly one
    // exact match — and the resolver should still surface it (so the caller
    // can show "login required" instead of "missing").
    const resolution = resolveOpenCodeModelInput(
      "openai/gpt-5",
      catalog as any,
    );

    expect(resolution.kind).toBe("exact");
    if (resolution.kind !== "exact") return;
    expect(resolution.model.providerID).toBe("openai");
    expect(resolution.model.selectable).toBe(false);
  });
});
