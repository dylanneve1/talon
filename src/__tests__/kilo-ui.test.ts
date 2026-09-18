import { describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// The error text carries the profile's label ("Kilo") and renders each
// match through the shared selection-value helper, so this drives the Kilo
// profile's own bound catalog against a hand-built catalog object.
const { kiloProfile } =
  await import("../backend/remote-server/profiles/kilo.js");
const formatOpenCodeSelectionError = kiloProfile.catalog.formatSelectionError;

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "m",
    name: "M",
    providerID: "p",
    providerName: "P",
    providerSource: "api",
    connected: false,
    selectable: false,
    loginRequired: true,
    envRequired: false,
    authMethods: ["OAuth"],
    free: false,
    status: "active",
    contextWindow: 400_000,
    outputWindow: 128_000,
    reasoning: true,
    attachment: true,
    toolcall: true,
    costInput: 1,
    costOutput: 2,
    costCacheRead: 0,
    costCacheWrite: 0,
    ...overrides,
  };
}

const emptyCatalog = {
  generatedAt: Date.now(),
  providers: [],
  models: [],
  connectedProviders: [],
  loginProviders: [],
  connectedModels: [],
  connectedFreeModels: [],
};

describe("formatOpenCodeSelectionError (Kilo)", () => {
  it("includes provider details for ambiguous matches", () => {
    const matches = [
      makeEntry({
        id: "gpt-5",
        name: "GPT-5",
        providerID: "openai",
        providerName: "OpenAI",
      }),
      makeEntry({
        id: "gpt-5",
        name: "GPT-5",
        providerID: "github-copilot",
        providerName: "GitHub Copilot",
      }),
    ];

    const text = formatOpenCodeSelectionError(
      "gpt-5",
      { kind: "ambiguous", matches: matches as any },
      { ...emptyCatalog, models: matches } as any,
    );

    expect(text).toContain("OpenAI / openai");
    expect(text).toContain("GitHub Copilot / github-copilot");
    expect(text).toContain("login required");
    expect(text).toContain("openai/gpt-5");
    expect(text).toContain("github-copilot/gpt-5");
  });

  it("returns missing message for no matches", () => {
    const text = formatOpenCodeSelectionError(
      "nonexistent",
      { kind: "missing", matches: [] } as any,
      emptyCatalog as any,
    );
    expect(text).toContain("nonexistent");
    expect(text).toContain("No Kilo model matched");
  });
});
