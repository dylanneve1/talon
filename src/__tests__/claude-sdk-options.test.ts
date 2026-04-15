import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();
const mockGetChatSettings = vi.fn();
const mockGetPluginMcpServers = vi.fn();
const mockGetConfig = vi.fn();
const mockGetBridgePort = vi.fn();

vi.mock("../storage/sessions.js", () => ({
  getSession: (...args: unknown[]) =>
    mockGetSession(...(args as Parameters<typeof mockGetSession>)),
}));

vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: (...args: unknown[]) =>
    mockGetChatSettings(...(args as Parameters<typeof mockGetChatSettings>)),
}));

vi.mock("../core/plugin.js", () => ({
  getPluginMcpServers: (...args: unknown[]) =>
    mockGetPluginMcpServers(
      ...(args as Parameters<typeof mockGetPluginMcpServers>),
    ),
}));

vi.mock("../backend/claude-sdk/state.js", () => ({
  getConfig: (...args: unknown[]) =>
    mockGetConfig(...(args as Parameters<typeof mockGetConfig>)),
  getBridgePort: (...args: unknown[]) =>
    mockGetBridgePort(...(args as Parameters<typeof mockGetBridgePort>)),
}));

describe("buildSdkOptions", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetSession.mockReturnValue({ sessionId: null });
    mockGetChatSettings.mockReturnValue({});
    mockGetPluginMcpServers.mockReturnValue({});
    mockGetConfig.mockReturnValue({
      model: "claude-sonnet-4-6",
      frontend: "terminal",
      systemPrompt: "test prompt",
      workspace: "/tmp/workspace",
    });
    mockGetBridgePort.mockReturnValue(19876);

    const { clearModels, registerModels } = await import("../core/models.js");
    clearModels();
    registerModels([
      {
        id: "default",
        displayName: "Default (recommended)",
        description: "Sonnet 4.6 · Best for everyday tasks",
        aliases: ["claude-sonnet-4-6"],
        provider: "anthropic",
        fallback: "haiku",
      },
      {
        id: "sonnet[1m]",
        displayName: "Sonnet (1M context)",
        description:
          "Sonnet 4.6 with 1M context · Billed as extra usage · $3/$15 per Mtok",
        aliases: ["claude-sonnet-4-6[1m]"],
        provider: "anthropic",
        fallback: "haiku",
      },
      {
        id: "haiku",
        displayName: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
        aliases: ["claude-haiku-4-5"],
        provider: "anthropic",
      },
    ]);
  });

  it("resolves legacy aliases to canonical model ID and passes through", async () => {
    const { buildSdkOptions } =
      await import("../backend/claude-sdk/options.js");

    const { activeModel, options } = buildSdkOptions("chat-1");

    expect(activeModel).toBe("claude-sonnet-4-6");
    // Model is passed through as resolved — SDK handles context window
    expect(options.model).toBe("default");
  });

  it("passes model through unchanged when no alias resolution needed", async () => {
    mockGetChatSettings.mockReturnValue({ model: "haiku" });

    const { buildSdkOptions } =
      await import("../backend/claude-sdk/options.js");
    const { options } = buildSdkOptions("chat-2");

    expect(options.model).toBe("haiku");
  });

  it("resolves 1M aliases to their canonical SDK model ID", async () => {
    mockGetChatSettings.mockReturnValue({ model: "claude-sonnet-4-6[1m]" });

    const { buildSdkOptions } =
      await import("../backend/claude-sdk/options.js");
    const { activeModel, options } = buildSdkOptions("chat-3");

    expect(activeModel).toBe("claude-sonnet-4-6[1m]");
    expect(options.model).toBe("sonnet[1m]");
  });
});
