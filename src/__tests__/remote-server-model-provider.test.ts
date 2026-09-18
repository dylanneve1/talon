/**
 * Tests for `createRemoteModelProvider` — the adapter that maps a
 * remote-server backend's catalog to the `UnifiedModelInfo` /
 * resolution / provider shapes the `Backend.models` slot exposes to
 * the dispatcher and frontend pickers.
 *
 * Every member of the family (`remote-server/profiles/*`) binds this
 * one factory, so these tests cover all of them. The fixture below is
 * Kilo-flavoured — label, provider ids, error text — because that is
 * what the assertions were written against. They exist because this
 * glue is the easiest place for a model-shape regression to slip past
 * tsc.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import type { RemoteModelProviderDeps } from "../backend/remote-server/model-catalog/provider.js";

const { createRemoteModelProvider } =
  await import("../backend/remote-server/model-catalog/index.js");

// ---------------------------------------------------------------------------
// Fixture: a hand-built kilo catalog.
//
// Three providers — one connected, one login-required, one not-yet-set-up;
// four models split across them. Fed to the adapter through the stubs below.
// ---------------------------------------------------------------------------

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "m",
    name: "M",
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

const connectedProvider = {
  id: "kilo",
  name: "Kilo",
  source: "api",
  connected: true,
  envKeys: [],
  authMethods: [],
  modelCount: 2,
  loginRequired: false,
  envRequired: false,
};

const loginProvider = {
  id: "openai",
  name: "OpenAI",
  source: "api",
  connected: false,
  envKeys: [],
  authMethods: ["OAuth"],
  modelCount: 1,
  loginRequired: true,
  envRequired: false,
};

const envProvider = {
  id: "anthropic",
  name: "Anthropic",
  source: "api",
  connected: false,
  envKeys: ["ANTHROPIC_API_KEY"],
  authMethods: [],
  modelCount: 1,
  loginRequired: false,
  envRequired: true,
};

const m1 = makeEntry({
  id: "big-pickle",
  name: "Big Pickle",
  providerID: "kilo",
  providerName: "Kilo",
  free: true,
  costInput: 0,
  costOutput: 0,
});
const m2 = makeEntry({
  id: "small-cucumber",
  name: "Small Cucumber",
  providerID: "kilo",
  providerName: "Kilo",
});
const m3 = makeEntry({
  id: "gpt-5",
  name: "GPT-5",
  providerID: "openai",
  providerName: "OpenAI",
  connected: false,
  selectable: false,
  loginRequired: true,
  authMethods: ["OAuth"],
});
const m4 = makeEntry({
  id: "claude-opus-4-7",
  name: "Claude Opus 4.7",
  providerID: "anthropic",
  providerName: "Anthropic",
  connected: false,
  selectable: false,
  envRequired: true,
});

const catalog = {
  generatedAt: Date.now(),
  providers: [connectedProvider, loginProvider, envProvider],
  models: [m1, m2, m3, m4],
  connectedProviders: [connectedProvider],
  loginProviders: [loginProvider],
  connectedModels: [m1, m2],
  connectedFreeModels: [m1],
};

// ---------------------------------------------------------------------------
// Bind the adapter over the static catalog above. A profile binds these
// same deps to its cached catalog module; here they are plain stubs, so
// no server is ever spun up.
// ---------------------------------------------------------------------------

const {
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  listModels,
  formatModelError,
} = createRemoteModelProvider({
  label: "Kilo",
  getCatalog: vi.fn(async () => catalog),
  getModelInfo: vi.fn(async (id: string) =>
    catalog.models.find((m) => m.id === id),
  ),
  resolveModelInput: vi.fn((query: string) => {
    if (query === "ambiguous") {
      return { kind: "ambiguous" as const, matches: [m1, m2] };
    }
    const match = catalog.models.find((m) => m.id === query);
    return match
      ? { kind: "exact" as const, model: match }
      : { kind: "missing" as const, matches: [] };
  }),
  getSelectionValue: vi.fn(
    (m: { providerID: string; id: string }) => `${m.providerID}/${m.id}`,
  ),
  // Only the two fields the adapter passes through are asserted on; the
  // picker's paging fields are the presentation module's own business.
  getSettingsPresentation: vi.fn(async () => ({
    modelButtons: [
      { text: "big-pickle", callback_data: "settings:model:big-pickle" },
    ],
    modelDetails: ["Kilo · 1 provider connected · 2 models usable"],
  })) as unknown as RemoteModelProviderDeps["getSettingsPresentation"],
  formatUnavailableModel: vi.fn(
    (m: { providerName: string; id: string }) =>
      `${m.providerName} not connected — ${m.id} unavailable`,
  ),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("remote-server model-provider — resolveModel", () => {
  it("returns exact resolution with storedValue using the provider-qualified slug", async () => {
    const result = await resolveModel("big-pickle");
    expect(result.kind).toBe("exact");
    if (result.kind !== "exact") return;
    expect(result.model.id).toBe("big-pickle");
    expect(result.model.providerName).toBe("Kilo");
    expect(result.model.selectable).toBe(true);
    expect(result.model.free).toBe(true);
    // storedValue is what gets persisted into chat settings — must round-trip.
    expect(result.storedValue).toBe("kilo/big-pickle");
  });

  it("maps ambiguous resolutions through toUnifiedModelInfo for every match", async () => {
    const result = await resolveModel("ambiguous");
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") return;
    expect(result.matches).toHaveLength(2);
    // Spot-check: each match has the unified shape, not the raw catalog entry.
    expect(result.matches[0].displayName).toBe("Big Pickle");
    expect(result.matches[0].provider).toBe("kilo");
    expect(result.matches[1].id).toBe("small-cucumber");
  });

  it("returns missing for unknown queries", async () => {
    const result = await resolveModel("nope-xyz");
    expect(result.kind).toBe("missing");
  });
});

describe("remote-server model-provider — getModelInfo", () => {
  it("maps a catalog entry to UnifiedModelInfo", async () => {
    const info = await getModelInfo("big-pickle");
    expect(info).toBeDefined();
    expect(info?.id).toBe("big-pickle");
    expect(info?.displayName).toBe("Big Pickle");
    expect(info?.provider).toBe("kilo");
    expect(info?.providerName).toBe("Kilo");
    expect(info?.selectable).toBe(true);
    expect(info?.free).toBe(true);
    // unavailableReason is only set for non-selectable models.
    expect(info?.unavailableReason).toBeUndefined();
  });

  it("sets unavailableReason for non-selectable models", async () => {
    const info = await getModelInfo("gpt-5");
    expect(info).toBeDefined();
    expect(info?.selectable).toBe(false);
    expect(info?.unavailableReason).toContain("OpenAI not connected");
  });

  it("returns undefined when the catalog has no such id", async () => {
    const info = await getModelInfo("does-not-exist");
    expect(info).toBeUndefined();
  });
});

describe("remote-server model-provider — getProviders", () => {
  it("lists connected providers first, then login-required providers", async () => {
    const providers = await getProviders();
    // Connected providers come first…
    expect(providers[0]).toMatchObject({
      id: "kilo",
      name: "Kilo",
      connected: true,
      modelCount: 2,
    });
    // …then login-required providers.
    const loginIdx = providers.findIndex((p) => p.id === "openai");
    expect(loginIdx).toBeGreaterThan(0);
    expect(providers[loginIdx]).toMatchObject({
      id: "openai",
      connected: false,
    });
  });

  it("does not duplicate a provider if it appears in both connected and login lists", async () => {
    const providers = await getProviders();
    const ids = providers.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("excludes env-only providers (only connected + login surfaces)", async () => {
    // Anthropic in the fixture is envRequired but not in loginProviders or
    // connectedProviders — getProviders intentionally surfaces only those two
    // buckets, so env-only providers don't appear without an auth method.
    const providers = await getProviders();
    expect(providers.find((p) => p.id === "anthropic")).toBeUndefined();
  });
});

describe("remote-server model-provider — getProviderModels", () => {
  it("returns the right slice for page 1 and a page size that fits", async () => {
    const { models, total } = await getProviderModels("kilo", 1, 8);
    expect(total).toBe(2);
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toEqual(["big-pickle", "small-cucumber"]);
  });

  it("paginates correctly when pageSize is smaller than total", async () => {
    const page1 = await getProviderModels("kilo", 1, 1);
    const page2 = await getProviderModels("kilo", 2, 1);
    expect(page1.models.map((m) => m.id)).toEqual(["big-pickle"]);
    expect(page2.models.map((m) => m.id)).toEqual(["small-cucumber"]);
    expect(page1.total).toBe(2);
    expect(page2.total).toBe(2);
  });

  it("returns an empty page past the end without throwing", async () => {
    const { models, total } = await getProviderModels("kilo", 99, 8);
    expect(models).toEqual([]);
    expect(total).toBe(2);
  });

  it("returns no models for an unknown provider", async () => {
    const { models, total } = await getProviderModels("nobody", 1, 8);
    expect(models).toEqual([]);
    expect(total).toBe(0);
  });
});

describe("remote-server model-provider — listModels", () => {
  it("returns all connected models when filter is 'all' or omitted", async () => {
    const all = await listModels("all");
    expect(all.total).toBe(2);
    expect(all.models.map((m) => m.id).sort()).toEqual([
      "big-pickle",
      "small-cucumber",
    ]);

    const def = await listModels();
    expect(def.total).toBe(2);
  });

  it("returns only free connected models when filter is 'free'", async () => {
    const free = await listModels("free");
    expect(free.total).toBe(1);
    expect(free.models).toHaveLength(1);
    expect(free.models[0].id).toBe("big-pickle");
    expect(free.models[0].free).toBe(true);
  });
});

describe("remote-server model-provider — formatModelError", () => {
  it("returns empty string for exact resolutions", () => {
    const msg = formatModelError("big-pickle", {
      kind: "exact",
      model: {
        id: "big-pickle",
        displayName: "Big Pickle",
        provider: "kilo",
        providerName: "Kilo",
        selectable: true,
      },
      storedValue: "kilo/big-pickle",
    });
    expect(msg).toBe("");
  });

  it("returns a Kilo-flavoured missing message including the query", () => {
    const msg = formatModelError("foo-bar-baz", { kind: "missing" });
    expect(msg).toContain("foo-bar-baz");
    expect(msg).toMatch(/no .* model matched/i);
  });

  it("returns an ambiguous message listing up to 6 matches with provider names", () => {
    const make = (i: number) => ({
      id: `m${i}`,
      displayName: `Model ${i}`,
      provider: `prov${i}`,
      providerName: `Prov ${i}`,
      selectable: true,
    });
    const matches = Array.from({ length: 10 }, (_, i) => make(i));
    const msg = formatModelError("ambig", { kind: "ambiguous", matches });
    expect(msg).toContain("ambig");
    expect(msg).toContain("ambiguous");
    // Each formatted entry: "<id> (<providerName>)"
    expect(msg).toContain("m0 (Prov 0)");
    expect(msg).toContain("m5 (Prov 5)");
    // Cap at 6.
    expect(msg).not.toContain("m6 (");
    expect(msg).not.toContain("m9 (");
  });
});

describe("remote-server model-provider — getSettingsPresentation", () => {
  it("delegates to getOpenCodeSettingsPresentation and passes the callback prefix", async () => {
    const presentation = await getSettingsPresentation("big-pickle", {
      callbackPrefix: "settings:model:",
    });
    expect(presentation.modelButtons).toEqual([
      { text: "big-pickle", callback_data: "settings:model:big-pickle" },
    ]);
    expect(presentation.modelDetails[0]).toContain("Kilo");
  });
});
