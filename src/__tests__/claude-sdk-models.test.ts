import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSupportedModels = vi.fn();

// The mock forwards the seed model (options.model) to mockSupportedModels so
// tests can simulate the binary's per-seed echo behaviour. Tests using
// mockResolvedValue ignore the arg and return the same list for every seed.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn((opts) => ({
    supportedModels: () => mockSupportedModels(opts?.options?.model),
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

    const { clearModels } = await import("../core/models/catalog.js");
    clearModels();
  });

  it("surfaces base and 1M variants separately while collapsing true duplicates", async () => {
    const { registerClaudeModels } =
      await import("../backend/claude-sdk/models/index.js");
    const { getModels, resolveModelId } =
      await import("../core/models/catalog.js");

    await registerClaudeModels({ model: "default" });

    // Base sonnet ("default") and sonnet[1m] are distinct context sizes, so
    // both surface. The longhand `claude-sonnet-4-6` is a true duplicate of the
    // base and collapses into "default". opus/opus[1m] likewise both surface.
    const anthropicModels = getModels("anthropic");
    expect(anthropicModels.map((model) => model.id)).toEqual([
      "default",
      "sonnet[1m]",
      "opus",
      "opus[1m]",
      "haiku",
    ]);

    const byId = (id: string) =>
      anthropicModels.find((model) => model.id === id);
    expect(byId("default")?.displayName).toBe("Sonnet 4.6");
    expect(byId("sonnet[1m]")?.displayName).toBe("Sonnet 4.6 (1M context)");
    expect(byId("opus")?.displayName).toBe("Opus 4.6");
    expect(byId("opus[1m]")?.displayName).toBe("Opus 4.6 (1M context)");
    expect(byId("haiku")?.displayName).toBe("Haiku 4.5");

    // Bare aliases resolve to the base entry; [1m] aliases to the 1M entry.
    expect(resolveModelId("sonnet")).toBe("default");
    expect(resolveModelId("claude-sonnet-4-6")).toBe("default");
    expect(resolveModelId("sonnet[1m]")).toBe("sonnet[1m]");
    expect(resolveModelId("claude-sonnet-4-6[1m]")).toBe("sonnet[1m]");
    expect(resolveModelId("opus")).toBe("opus");
    expect(resolveModelId("claude-opus-4-6")).toBe("opus");
    expect(resolveModelId("opus[1m]")).toBe("opus[1m]");
    expect(resolveModelId("claude-opus-4-6[1m]")).toBe("opus[1m]");
  });

  it("resolves family aliases for a model shipped only as a 1M variant (Fable)", async () => {
    // Mirrors real SDK output: Fable is advertised solely as
    // `claude-fable-5[1m]` with no base (non-1M) entry, and a bare
    // `displayName: "Fable"` whose version lives only in the description.
    mockSupportedModels.mockResolvedValue([
      {
        value: "default",
        displayName: "Default (recommended)",
        description: "Opus 4.7 with 1M context · Most capable for complex work",
      },
      {
        value: "sonnet",
        displayName: "Sonnet",
        description: "Sonnet 4.6 · Best for everyday tasks",
      },
      {
        value: "sonnet[1m]",
        displayName: "Sonnet (1M context)",
        description: "Sonnet 4.6 with 1M context · $3/$15 per Mtok",
      },
      {
        value: "haiku",
        displayName: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
      },
      {
        value: "claude-fable-5[1m]",
        displayName: "Fable",
        description:
          "Fable 5 · Most capable for your hardest and longest-running tasks",
      },
    ]);

    const { registerClaudeModels } =
      await import("../backend/claude-sdk/models/index.js");
    const { getModels, resolveModelId } =
      await import("../core/models/catalog.js");

    await registerClaudeModels({ model: "default" });

    const fable = getModels("anthropic").find((m) =>
      m.id.startsWith("claude-fable-5"),
    );
    expect(fable, "Fable should be discovered").toBeDefined();
    expect(fable?.id).toBe("claude-fable-5[1m]");
    expect(fable?.displayName).toBe("Fable 5 (1M context)");

    // The bug: with no base variant, the bare family aliases were never
    // generated, so "/model fable" (and the version forms) failed to resolve.
    expect(resolveModelId("fable")).toBe("claude-fable-5[1m]");
    expect(resolveModelId("fable-5")).toBe("claude-fable-5[1m]");
    expect(resolveModelId("fable[1m]")).toBe("claude-fable-5[1m]");
    expect(resolveModelId("claude-fable-5")).toBe("claude-fable-5[1m]");
    expect(resolveModelId("claude-fable-5[1m]")).toBe("claude-fable-5[1m]");
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
      await import("../backend/claude-sdk/models/index.js");
    const { resolveModelId } = await import("../core/models/catalog.js");

    await registerClaudeModels({ model: "default" });

    expect(resolveModelId("claude-sonnet-5-0")).toBe("default");
    expect(resolveModelId("claude-sonnet-4-6")).toBe("default");
    expect(resolveModelId("claude-opus-5-0")).toBe("opus");
    expect(resolveModelId("claude-opus-4-6")).toBe("opus");
    expect(resolveModelId("claude-haiku-5-0")).toBe("haiku");
    expect(resolveModelId("claude-haiku-4-5")).toBe("haiku");
  });

  it("unions probes across family seeds so base and 1M variants both surface", async () => {
    // Simulate the real binary: a base set that echoes only the *requested*
    // model's context variant. A single "default" probe shows opus only as the
    // 1M `default`; the base opus surfaces only when probing the "opus" seed.
    // Unrecognised seeds come back as "Custom model" passthrough junk.
    const BASE = [
      {
        value: "sonnet",
        displayName: "Sonnet",
        description: "Sonnet 4.6 · Best for everyday tasks",
      },
      {
        value: "sonnet[1m]",
        displayName: "Sonnet (1M context)",
        description: "Sonnet 4.6 with 1M context",
      },
      {
        value: "haiku",
        displayName: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
      },
    ];
    const ECHO: Record<string, { value: string; description: string }> = {
      default: {
        value: "default",
        description: "Opus 4.7 with 1M context · Most capable for complex work",
      },
      opus: {
        value: "opus",
        description: "Opus 4.7 · Most capable for complex work",
      },
      sonnet: {
        value: "sonnet",
        description: "Sonnet 4.6 · Best for everyday tasks",
      },
      haiku: {
        value: "haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
      },
    };
    mockSupportedModels.mockImplementation((seed?: string) => {
      const echo = ECHO[seed ?? ""] ?? {
        value: seed ?? "unknown",
        description: "Custom model",
      };
      return Promise.resolve([
        ...BASE,
        {
          value: echo.value,
          displayName: echo.value,
          description: echo.description,
        },
      ]);
    });

    const { registerClaudeModels } =
      await import("../backend/claude-sdk/models/index.js");
    const { getModels, resolveModelId } =
      await import("../core/models/catalog.js");

    await registerClaudeModels({ model: "default" });

    const ids = getModels("anthropic").map((m) => m.id);
    // The "opus" seed probe reveals base opus; "default" carries opus 1M.
    expect(ids).toContain("opus");
    expect(ids).toContain("default");
    expect(ids).toContain("sonnet");
    expect(ids).toContain("sonnet[1m]");

    // Both opus context sizes resolve, to distinct entries.
    expect(resolveModelId("opus")).toBe("opus");
    expect(resolveModelId("opus[1m]")).toBe("default");

    // No "Custom model" passthrough junk leaked into the registry.
    const descriptions = getModels("anthropic").map((m) => m.description);
    expect(descriptions).not.toContain("Custom model");
  });
});
