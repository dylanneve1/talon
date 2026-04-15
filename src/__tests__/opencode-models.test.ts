import { describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const { getOpenCodeModelSelectionValue, resolveOpenCodeModelInput } =
  await import("../backend/opencode/index.js");

const catalog = {
  generatedAt: Date.now(),
  providers: [],
  connectedProviders: [],
  loginProviders: [],
  connectedModels: [],
  connectedFreeModels: [],
  models: [
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
      connected: true,
      selectable: true,
      loginRequired: false,
      envRequired: false,
      authMethods: [],
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
      id: "big-pickle",
      name: "Big Pickle",
      providerID: "opencode",
      providerName: "OpenCode Zen",
      providerSource: "api",
      connected: true,
      selectable: true,
      loginRequired: false,
      envRequired: false,
      authMethods: [],
      free: true,
      status: "active",
      contextWindow: 200000,
      outputWindow: 128000,
      reasoning: true,
      attachment: false,
      toolcall: true,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
    },
  ],
};

describe("OpenCode model resolution", () => {
  it("resolves provider-qualified model queries exactly", () => {
    const resolution = resolveOpenCodeModelInput(
      "github-copilot/gpt-5",
      catalog,
    );

    expect(resolution.kind).toBe("exact");
    if (resolution.kind !== "exact") return;
    expect(resolution.model.providerID).toBe("github-copilot");
  });

  it("uses provider-qualified storage values only for colliding model ids", () => {
    const duplicateValue = getOpenCodeModelSelectionValue(
      catalog.models[0],
      catalog,
    );
    const uniqueValue = getOpenCodeModelSelectionValue(
      catalog.models[2],
      catalog,
    );

    expect(duplicateValue).toBe("openai/gpt-5");
    expect(uniqueValue).toBe("big-pickle");
  });
});
