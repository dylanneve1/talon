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
  }, 10_000);

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

  describe("PostToolBatch turn-terminator hook", () => {
    type HookCallback = (
      input: unknown,
      toolUseID?: string,
      ctx?: { signal: AbortSignal },
    ) => Promise<{ continue?: boolean; stopReason?: string }>;

    const callHook = async (toolNames: string[]): Promise<unknown> => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-hook-test");

      const matchers = options.hooks?.PostToolBatch;
      expect(matchers).toBeDefined();
      expect(matchers!.length).toBe(1);
      const hook = matchers![0]!.hooks[0] as unknown as HookCallback;

      return hook(
        {
          hook_event_name: "PostToolBatch",
          tool_calls: toolNames.map((name, i) => ({
            tool_name: name,
            tool_input: {},
            tool_use_id: `tu_${i}`,
          })),
        },
        undefined,
        { signal: new AbortController().signal },
      );
    };

    it("registers a PostToolBatch hook on the options object", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-hook-1");
      expect(options.hooks?.PostToolBatch).toBeDefined();
      expect(options.hooks!.PostToolBatch!.length).toBe(1);
      expect(options.hooks!.PostToolBatch![0]!.hooks.length).toBe(1);
    });

    it("returns continue:false when an MCP-prefixed end_turn is in the batch", async () => {
      const result = (await callHook([
        "mcp__telegram-tools__send",
        "mcp__telegram-tools__end_turn",
      ])) as { continue: boolean; stopReason?: string };
      expect(result.continue).toBe(false);
      expect(result.stopReason).toMatch(/end_turn/i);
    });

    it("returns continue:false when a bare end_turn is in the batch", async () => {
      const result = (await callHook(["end_turn"])) as {
        continue: boolean;
      };
      expect(result.continue).toBe(false);
    });

    it("returns continue:true when no terminator is in the batch", async () => {
      const result = (await callHook([
        "mcp__telegram-tools__send",
        "Read",
        "Bash",
      ])) as { continue: boolean };
      expect(result.continue).toBe(true);
    });

    it("returns continue:true on an empty batch", async () => {
      const result = (await callHook([])) as { continue: boolean };
      expect(result.continue).toBe(true);
    });

    it("ignores non-PostToolBatch events defensively", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-hook-defensive");
      const hook = options.hooks!.PostToolBatch![0]!.hooks[0] as unknown as (
        input: unknown,
        id?: string,
        ctx?: { signal: AbortSignal },
      ) => Promise<{ continue: boolean }>;

      const result = await hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "mcp__telegram-tools__end_turn",
          tool_input: {},
          tool_response: {},
          tool_use_id: "tu_0",
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });
  });

  describe("Notification hook", () => {
    type HookCallback = (
      input: unknown,
      toolUseID?: string,
      ctx?: { signal: AbortSignal },
    ) => Promise<{ continue: boolean }>;

    const getNotifHook = async (): Promise<HookCallback> => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-notif");
      const matchers = options.hooks?.Notification;
      expect(matchers).toBeDefined();
      return matchers![0]!.hooks[0] as unknown as HookCallback;
    };

    it("registers a Notification hook on the options object", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-notif-1");
      expect(options.hooks?.Notification).toBeDefined();
      expect(options.hooks!.Notification!.length).toBe(1);
      expect(options.hooks!.Notification![0]!.hooks.length).toBe(1);
    });

    it("returns continue:true for Notification events", async () => {
      const hook = await getNotifHook();
      const result = await hook(
        {
          hook_event_name: "Notification",
          message: "Compacting context...",
          notification_type: "compaction",
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });

    it("returns continue:true for Notification events with optional title", async () => {
      const hook = await getNotifHook();
      const result = await hook(
        {
          hook_event_name: "Notification",
          message: "Switched to claude-haiku-4-5",
          title: "Model switch",
          notification_type: "model_switch",
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });

    it("ignores non-Notification events defensively", async () => {
      const hook = await getNotifHook();
      const result = await hook(
        {
          hook_event_name: "PostToolBatch",
          tool_calls: [],
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });
  });

  describe("StopFailure hook", () => {
    type HookCallback = (
      input: unknown,
      toolUseID?: string,
      ctx?: { signal: AbortSignal },
    ) => Promise<{ continue: boolean }>;

    const getStopFailureHook = async (): Promise<HookCallback> => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-sf");
      const matchers = options.hooks?.StopFailure;
      expect(matchers).toBeDefined();
      return matchers![0]!.hooks[0] as unknown as HookCallback;
    };

    it("registers a StopFailure hook on the options object", async () => {
      const { buildSdkOptions } =
        await import("../backend/claude-sdk/options.js");
      const { options } = buildSdkOptions("chat-sf-1");
      expect(options.hooks?.StopFailure).toBeDefined();
      expect(options.hooks!.StopFailure!.length).toBe(1);
      expect(options.hooks!.StopFailure![0]!.hooks.length).toBe(1);
    });

    it("returns continue:true for StopFailure events with error_details", async () => {
      const hook = await getStopFailureHook();
      const result = await hook(
        {
          hook_event_name: "StopFailure",
          error: {
            type: "error",
            error: { type: "api_error", message: "upstream failure" },
          },
          error_details: "raw response body here",
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });

    it("returns continue:true for StopFailure events without error_details", async () => {
      const hook = await getStopFailureHook();
      const result = await hook(
        {
          hook_event_name: "StopFailure",
          error: {
            type: "error",
            error: { type: "overloaded_error", message: "rate limited" },
          },
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });

    it("ignores non-StopFailure events defensively", async () => {
      const hook = await getStopFailureHook();
      const result = await hook(
        {
          hook_event_name: "Notification",
          message: "context compacting",
          notification_type: "compaction",
        },
        undefined,
        { signal: new AbortController().signal },
      );
      expect(result.continue).toBe(true);
    });
  });
});

// ── getActiveFrontends ────────────────────────────────────────────────────
//
// Direct unit tests for the helper added alongside the heartbeat outbound
// refactor. Used by the heartbeat agent to build a frontend-agnostic system
// prompt (lists every `${frontend}-tools` MCP server actually available
// instead of hard-coding "telegram-tools").

describe("getActiveFrontends", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns [] when frontend is scalar 'terminal'", async () => {
    mockGetConfig.mockReturnValue({ frontend: "terminal" });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual([]);
  });

  it("returns ['telegram'] when frontend is scalar 'telegram'", async () => {
    mockGetConfig.mockReturnValue({ frontend: "telegram" });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual(["telegram"]);
  });

  it("returns ['teams'] when frontend is scalar 'teams'", async () => {
    mockGetConfig.mockReturnValue({ frontend: "teams" });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual(["teams"]);
  });

  it("returns full array when frontend is ['telegram', 'teams']", async () => {
    mockGetConfig.mockReturnValue({ frontend: ["telegram", "teams"] });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual(["telegram", "teams"]);
  });

  it("filters terminal out of mixed arrays", async () => {
    mockGetConfig.mockReturnValue({
      frontend: ["telegram", "terminal", "teams"],
    });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual(["telegram", "teams"]);
  });

  it("returns [] when array contains only terminal", async () => {
    mockGetConfig.mockReturnValue({ frontend: ["terminal"] });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual([]);
  });

  it("preserves array order (heartbeat prompt uses [0] as example)", async () => {
    mockGetConfig.mockReturnValue({ frontend: ["teams", "telegram"] });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(getActiveFrontends()).toEqual(["teams", "telegram"]);
  });

  it("propagates getConfig() throw (callers wrap in try/catch)", async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error("config not initialised");
    });
    const { getActiveFrontends } =
      await import("../backend/claude-sdk/options.js");
    expect(() => getActiveFrontends()).toThrow("config not initialised");
  });
});

// ── buildMcpServers — heartbeat-tier coverage ─────────────────────────────
//
// Tests focused on the heartbeat sentinel pathway and multi-frontend
// correctness. The chat-mode happy path is covered by integration tests
// (talon-mcp-functional*.test.ts).

describe("buildMcpServers (heartbeat-tier paths)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetBridgePort.mockReturnValue(19876);
  });

  it("returns empty map when frontend is 'terminal' and no braveApiKey", async () => {
    mockGetConfig.mockReturnValue({ frontend: "terminal" });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    expect(buildMcpServers("heartbeat")).toEqual({});
  });

  it("spawns one '<frontend>-tools' server per non-terminal frontend", async () => {
    mockGetConfig.mockReturnValue({ frontend: ["telegram", "teams"] });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("heartbeat");
    expect(Object.keys(servers).sort()).toEqual([
      "teams-tools",
      "telegram-tools",
    ]);
  });

  it("teams-only config produces teams-tools, not telegram-tools", async () => {
    mockGetConfig.mockReturnValue({ frontend: "teams" });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("heartbeat");
    expect(servers).toHaveProperty("teams-tools");
    expect(servers).not.toHaveProperty("telegram-tools");
  });

  it("env includes TALON_CHAT_ID, TALON_FRONTEND, TALON_BRIDGE_URL", async () => {
    mockGetConfig.mockReturnValue({ frontend: "telegram" });
    mockGetBridgePort.mockReturnValue(31337);
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("352042062");
    const env = (servers["telegram-tools"] as { env: Record<string, string> })
      .env;
    expect(env).toMatchObject({
      TALON_CHAT_ID: "352042062",
      TALON_FRONTEND: "telegram",
      TALON_BRIDGE_URL: "http://127.0.0.1:31337",
    });
  });

  it("heartbeat sentinel: TALON_CHAT_ID is 'heartbeat' when chatId='heartbeat'", async () => {
    mockGetConfig.mockReturnValue({ frontend: "telegram" });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("heartbeat");
    const env = (servers["telegram-tools"] as { env: Record<string, string> })
      .env;
    expect(env.TALON_CHAT_ID).toBe("heartbeat");
  });

  it("multi-frontend + brave produces 3 servers", async () => {
    mockGetConfig.mockReturnValue({
      frontend: ["telegram", "teams"],
      braveApiKey: "bsa_test_key",
    });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("heartbeat");
    expect(Object.keys(servers).sort()).toEqual([
      "brave-search",
      "teams-tools",
      "telegram-tools",
    ]);
    // Both frontend servers get the heartbeat sentinel.
    expect(
      (servers["telegram-tools"] as { env: Record<string, string> }).env
        .TALON_CHAT_ID,
    ).toBe("heartbeat");
    expect(
      (servers["teams-tools"] as { env: Record<string, string> }).env
        .TALON_CHAT_ID,
    ).toBe("heartbeat");
  });

  it("each frontend gets its own TALON_FRONTEND env (no cross-pollination)", async () => {
    mockGetConfig.mockReturnValue({ frontend: ["telegram", "teams"] });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    const servers = buildMcpServers("heartbeat");
    expect(
      (servers["telegram-tools"] as { env: Record<string, string> }).env
        .TALON_FRONTEND,
    ).toBe("telegram");
    expect(
      (servers["teams-tools"] as { env: Record<string, string> }).env
        .TALON_FRONTEND,
    ).toBe("teams");
  });

  it("includes brave-search when braveApiKey set, even for terminal-only", async () => {
    mockGetConfig.mockReturnValue({
      frontend: "terminal",
      braveApiKey: "bsa_test_key",
    });
    const { buildMcpServers } =
      await import("../backend/claude-sdk/options.js");
    expect(Object.keys(buildMcpServers("heartbeat"))).toEqual(["brave-search"]);
  });
});
