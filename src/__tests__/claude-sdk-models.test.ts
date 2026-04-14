import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSupportedModels = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({
    supportedModels: mockSupportedModels,
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined }),
      };
    },
  })),
}));

const sdkModels = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Sonnet 4.6 · Best for everyday tasks",
  },
  {
    value: "sonnet[1m]",
    displayName: "Sonnet (1M context)",
    description:
      "Sonnet 4.6 with 1M context · Billed as extra usage · $3/$15 per Mtok",
  },
  {
    value: "opus",
    displayName: "Opus",
    description: "Opus 4.6 · Most capable for complex work",
  },
  {
    value: "opus[1m]",
    displayName: "Opus (1M context)",
    description:
      "Opus 4.6 with 1M context · Billed as extra usage · $5/$25 per Mtok",
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "claude-sonnet-4-6",
  },
];

describe("registerClaudeModels", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSupportedModels.mockResolvedValue(sdkModels);

    const { clearModels } = await import("../core/models.js");
    clearModels();
  });

  it("keeps SDK IDs/display names and maps 1M upgrades explicitly", async () => {
    const { registerClaudeModels } = await import(
      "../backend/claude-sdk/models.js"
    );
    const {
      get1mContextModelId,
      getModels,
      resolveModelId,
      supports1mContext,
    } = await import("../core/models.js");

    await registerClaudeModels({ model: "default" });

    const anthropicModels = getModels("anthropic");
    expect(anthropicModels.map((model) => model.id)).toEqual([
      "opus",
      "opus[1m]",
      "default",
      "sonnet[1m]",
      "haiku",
    ]);

    expect(
      anthropicModels.find((model) => model.id === "default")?.displayName,
    ).toBe("Default (recommended)");
    expect(
      anthropicModels.find((model) => model.id === "sonnet[1m]")?.displayName,
    ).toBe("Sonnet (1M context)");
    expect(anthropicModels.some((model) => model.id === "claude-sonnet-4-6")).toBe(
      false,
    );

    expect(resolveModelId("claude-sonnet-4-6")).toBe("default");
    expect(resolveModelId("claude-sonnet-4-6[1m]")).toBe("sonnet[1m]");
    expect(resolveModelId("claude-opus-4-6")).toBe("opus");

    expect(get1mContextModelId("default")).toBe("sonnet[1m]");
    expect(get1mContextModelId("claude-sonnet-4-6")).toBe("sonnet[1m]");
    expect(get1mContextModelId("opus")).toBe("opus[1m]");
    expect(get1mContextModelId("haiku")).toBeNull();

    expect(supports1mContext("claude-sonnet-4-6")).toBe(true);
    expect(supports1mContext("haiku")).toBe(false);
  });

  it("derives compatibility aliases from SDK metadata instead of hardcoded versions", async () => {
    mockSupportedModels.mockResolvedValue([
      {
        value: "default",
        displayName: "Default (recommended)",
        description: "Sonnet 5.0 · Best for everyday tasks",
      },
      {
        value: "sonnet[1m]",
        displayName: "Sonnet (1M context)",
        description:
          "Sonnet 5.0 with 1M context · Billed as extra usage · $3/$15 per Mtok",
      },
      {
        value: "opus",
        displayName: "Opus",
        description: "Opus 5.0 · Most capable for complex work",
      },
      {
        value: "opus[1m]",
        displayName: "Opus (1M context)",
        description:
          "Opus 5.0 with 1M context · Billed as extra usage · $5/$25 per Mtok",
      },
      {
        value: "haiku",
        displayName: "Haiku",
        description: "Haiku 5.0 · Fastest for quick answers",
      },
      {
        value: "claude-sonnet-5-0",
        displayName: "Sonnet 5.0",
        description: "claude-sonnet-5-0",
      },
    ]);

    const { registerClaudeModels } = await import(
      "../backend/claude-sdk/models.js"
    );
    const { get1mContextModelId, resolveModelId } = await import(
      "../core/models.js"
    );

    await registerClaudeModels({ model: "default" });

    expect(resolveModelId("claude-sonnet-5-0")).toBe("default");
    expect(resolveModelId("claude-sonnet-4-6")).toBe("default");
    expect(resolveModelId("claude-opus-5-0")).toBe("opus");
    expect(resolveModelId("claude-opus-4-6")).toBe("opus");
    expect(resolveModelId("claude-haiku-5-0")).toBe("haiku");
    expect(resolveModelId("claude-haiku-4-5")).toBe("haiku");
    expect(get1mContextModelId("claude-sonnet-4-6")).toBe("sonnet[1m]");
    expect(get1mContextModelId("claude-sonnet-5-0")).toBe("sonnet[1m]");
  });
});
