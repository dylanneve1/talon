import { describe, expect, it, vi } from "vitest";

vi.mock("../backend/opencode/index.js", () => ({
  getOpenCodeModelCatalog: vi.fn(),
  getOpenCodeModelInfo: vi.fn(),
  getOpenCodeModelSelectionValue: vi.fn(
    (model: { providerID?: string; id: string }) =>
      `${model.providerID}/${model.id}`,
  ),
  getOpenCodeQuickPickModels: vi.fn(),
  resolveOpenCodeModelInput: vi.fn(),
}));

const { formatOpenCodeSelectionError } =
  await import("../frontend/telegram/opencode-ui.js");

describe("OpenCode Telegram UI helpers", () => {
  it("includes provider details for ambiguous model matches", () => {
    const matches = [
      {
        id: "gpt-5",
        name: "GPT-5",
        providerID: "openai",
        providerName: "OpenAI",
        providerSource: "api",
        connected: false,
        selectable: false,
        loginRequired: true,
        envRequired: false,
        authMethods: ["OAuth"],
        free: false,
        status: "active",
        contextWindow: 400000,
        outputWindow: 128000,
        reasoning: true,
        attachment: true,
        toolcall: true,
        costInput: 1,
        costOutput: 2,
        costCacheRead: 0,
        costCacheWrite: 0,
      },
      {
        id: "gpt-5",
        name: "GPT-5",
        providerID: "github-copilot",
        providerName: "GitHub Copilot",
        providerSource: "api",
        connected: false,
        selectable: false,
        loginRequired: true,
        envRequired: false,
        authMethods: ["OAuth"],
        free: false,
        status: "active",
        contextWindow: 400000,
        outputWindow: 128000,
        reasoning: true,
        attachment: true,
        toolcall: true,
        costInput: 1,
        costOutput: 2,
        costCacheRead: 0,
        costCacheWrite: 0,
      },
    ];

    const text = formatOpenCodeSelectionError(
      "gpt-5",
      {
        kind: "ambiguous",
        matches,
      },
      {
        generatedAt: Date.now(),
        providers: [],
        models: matches,
        connectedProviders: [],
        loginProviders: [],
        connectedModels: [],
        connectedFreeModels: [],
      },
    );

    expect(text).toContain("OpenAI / openai");
    expect(text).toContain("GitHub Copilot / github-copilot");
    expect(text).toContain("login required");
    expect(text).toContain("openai/gpt-5");
    expect(text).toContain("github-copilot/gpt-5");
  });
});
