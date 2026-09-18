import { describe, expect, it } from "vitest";

// The error text carries the profile's label ("OpenCode") and renders each
// match through the shared selection-value helper, so this drives the
// OpenCode profile's own bound catalog against a hand-built catalog object.
const { opencodeProfile } =
  await import("../backend/remote-server/profiles/opencode.js");
const formatOpenCodeSelectionError =
  opencodeProfile.catalog.formatSelectionError;

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

describe("formatOpenCodeSelectionError", () => {
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
    expect(text).toContain("No OpenCode model matched");
  });
});
