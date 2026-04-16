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

  it("collapses family+version duplicates (base + 1M + claude-*) into a single canonical entry", async () => {
    const { registerClaudeModels } =
      await import("../backend/claude-sdk/models.js");
    const { getModels, resolveModelId } = await import("../core/models.js");

    await registerClaudeModels({ model: "default" });

    // sonnet, sonnet[1m], claude-sonnet-4-6 all share family+version and
    // collapse into "default" (the SDK's recommended canonical). opus/opus[1m]
    // collapse into opus[1m] (1M-preferred since no "default" exists for that
    // family). haiku stands alone.
    const anthropicModels = getModels("anthropic");
    expect(anthropicModels.map((model) => model.id)).toEqual([
      "default",
      "opus[1m]",
      "haiku",
    ]);

    expect(
      anthropicModels.find((model) => model.id === "default")?.displayName,
    ).toBe("Sonnet 4.6");
    expect(
      anthropicModels.find((model) => model.id === "opus[1m]")?.displayName,
    ).toBe("Opus 4.6");
    expect(
      anthropicModels.find((model) => model.id === "haiku")?.displayName,
    ).toBe("Haiku 4.5");

    expect(resolveModelId("sonnet")).toBe("default");
    expect(resolveModelId("sonnet[1m]")).toBe("default");
    expect(resolveModelId("claude-sonnet-4-6")).toBe("default");
    expect(resolveModelId("claude-sonnet-4-6[1m]")).toBe("default");
    expect(resolveModelId("opus")).toBe("opus[1m]");
    expect(resolveModelId("claude-opus-4-6")).toBe("opus[1m]");
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

    const { registerClaudeModels } =
      await import("../backend/claude-sdk/models.js");
    const { resolveModelId } = await import("../core/models.js");

    await registerClaudeModels({ model: "default" });

    expect(resolveModelId("claude-sonnet-5-0")).toBe("default");
    expect(resolveModelId("claude-sonnet-4-6")).toBe("default");
    expect(resolveModelId("claude-opus-5-0")).toBe("opus[1m]");
    expect(resolveModelId("claude-opus-4-6")).toBe("opus[1m]");
    expect(resolveModelId("claude-haiku-5-0")).toBe("haiku");
    expect(resolveModelId("claude-haiku-4-5")).toBe("haiku");
  });
});
