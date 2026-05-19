import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const resetSessionMock = vi.fn();
const setSessionIdMock = vi.fn();
const getPluginMcpServersMock = vi.fn();

vi.mock("../storage/sessions.js", () => ({
  getSession: getSessionMock,
  resetSession: resetSessionMock,
  setSessionId: setSessionIdMock,
}));

vi.mock("../core/plugin.js", () => ({
  getPluginMcpServers: getPluginMcpServersMock,
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const {
  initKiloAgent,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  ensureSession,
  resolveProviderID,
  parseStoredKiloModelSelection,
  stopKiloServer,
} = await import("../backend/kilo/server.js");

type MockKiloClient = {
  mcp: {
    status: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  tool: { ids: ReturnType<typeof vi.fn> };
  session: { get: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  provider: { list: ReturnType<typeof vi.fn> };
  permission: { allowEverything: ReturnType<typeof vi.fn> };
};

function makeClient(): MockKiloClient {
  return {
    mcp: { status: vi.fn(), add: vi.fn(), disconnect: vi.fn() },
    tool: { ids: vi.fn() },
    session: { get: vi.fn(), create: vi.fn() },
    provider: { list: vi.fn() },
    permission: { allowEverything: vi.fn().mockResolvedValue({}) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stopKiloServer();
  getSessionMock.mockReturnValue({});
  getPluginMcpServersMock.mockReturnValue({});
  initKiloAgent({} as never, () => 17777, "discord");
});

describe("kilo server helpers", () => {
  it("buildToolOverrides enables only tools from the active chat server", async () => {
    const oc = makeClient();
    oc.tool.ids.mockResolvedValue({
      data: [
        "talon-tools-chat_1_send_message",
        "talon-tools-other_send_message",
        "not-talon-tool",
        123,
      ],
    });

    const overrides = await buildToolOverrides(
      oc as never,
      "talon-tools-chat_1",
    );

    expect(overrides).toEqual({
      "talon-tools-chat_1_send_message": true,
      "talon-tools-other_send_message": false,
    });
  });

  it("buildToolOverrides returns undefined when no matching chat tools are present", async () => {
    const oc = makeClient();
    oc.tool.ids.mockResolvedValue({ data: ["talon-tools-other_send_message"] });
    await expect(
      buildToolOverrides(oc as never, "talon-tools-chat_1"),
    ).resolves.toBeUndefined();
  });

  it("ensureChatMcpServer registers the chat server with the right env", async () => {
    const oc = makeClient();

    const serverName = await ensureChatMcpServer(oc as never, "chat/1");

    expect(serverName).toBe("talon-tools-chat_1");
    expect(oc.mcp.add).toHaveBeenCalledTimes(1);
    expect(oc.mcp.add.mock.calls[0][0]).toMatchObject({
      name: "talon-tools-chat_1",
      config: {
        environment: {
          TALON_BRIDGE_URL: "http://127.0.0.1:17777",
          TALON_CHAT_ID: "chat/1",
          TALON_FRONTEND: "discord",
        },
      },
    });
  });

  it("ensureChatMcpServer skips the add when the server is already cached locally", async () => {
    const oc = makeClient();

    await ensureChatMcpServer(oc as never, "chat/1");
    expect(oc.mcp.add).toHaveBeenCalledTimes(1);

    // Second call uses the local cache — no new add. Kilo's GET /mcp
    // returns {} regardless of state, so we trust our own record of what
    // we registered earlier in this process.
    await ensureChatMcpServer(oc as never, "chat/1");
    expect(oc.mcp.add).toHaveBeenCalledTimes(1);
  });

  it("disconnectChatMcpServer clears the cache so a future ensure re-registers", async () => {
    const oc = makeClient();

    await ensureChatMcpServer(oc as never, "chat/1");
    await disconnectChatMcpServer(oc as never, "talon-tools-chat_1");
    await ensureChatMcpServer(oc as never, "chat/1");

    // Two adds: the initial registration and the post-disconnect one.
    expect(oc.mcp.add).toHaveBeenCalledTimes(2);
    expect(oc.mcp.disconnect).toHaveBeenCalledTimes(1);
  });

  it("ensureChatMcpServer disconnects OTHER chat MCP servers when switching chats", async () => {
    // Per-session permission rules block tool *execution* but not
    // *visibility* — Kilo still lists every connected MCP server's
    // tools in the model's catalog. So `talon-tools-chat_a` AND
    // `talon-tools-chat_b` connected at once means a model in chat A
    // can see and call `talon-tools-chat_b_send`. Holding only one
    // chat-namespaced server connected at a time is the only way to
    // hide cross-chat tools. The heartbeat sentinel server is exempt
    // (always allowed to coexist).
    const oc = makeClient();

    await ensureChatMcpServer(oc as never, "chat-a");
    await ensureChatMcpServer(oc as never, "heartbeat");
    expect(oc.mcp.add).toHaveBeenCalledTimes(2);

    // Switching to chat-b should disconnect chat-a but leave heartbeat
    // (heartbeat is the sentinel for background agent outbound calls).
    await ensureChatMcpServer(oc as never, "chat-b");

    expect(oc.mcp.disconnect).toHaveBeenCalledTimes(1);
    expect(oc.mcp.disconnect.mock.calls[0][0]).toEqual({
      name: "talon-tools-chat-a",
    });
    // chat-b registered now.
    expect(oc.mcp.add).toHaveBeenCalledTimes(3);
  });

  it("ensureChatMcpServer leaves heartbeat MCP server connected across chat switches", async () => {
    const oc = makeClient();

    await ensureChatMcpServer(oc as never, "heartbeat");
    await ensureChatMcpServer(oc as never, "chat-a");
    await ensureChatMcpServer(oc as never, "chat-b");

    // heartbeat MUST never get disconnected — it's the sentinel for
    // outbound tool calls from background agents (heartbeat / dream).
    const disconnectNames = (
      oc.mcp.disconnect.mock.calls as Array<[{ name: string }]>
    ).map((c) => c[0].name);
    expect(disconnectNames).not.toContain("talon-tools-heartbeat");
  });

  it("ensurePluginMcpServers registers all named servers on first call", async () => {
    const oc = makeClient();
    getPluginMcpServersMock.mockReturnValue({
      alpha: { command: "node", args: ["alpha.js"], env: { A: "1" } },
      beta: { command: "node", args: ["beta.js"], env: { B: "1" } },
    });

    const registered = await ensurePluginMcpServers(oc as never, "chat-1");

    expect(registered).toEqual(["alpha", "beta"]);
    expect(oc.mcp.add).toHaveBeenCalledTimes(2);
  });

  it("ensurePluginMcpServers skips already-cached servers on subsequent calls", async () => {
    const oc = makeClient();
    getPluginMcpServersMock.mockReturnValue({
      alpha: { command: "node", args: ["alpha.js"], env: { A: "1" } },
      beta: { command: "node", args: ["beta.js"], env: { B: "1" } },
    });

    await ensurePluginMcpServers(oc as never, "chat-1");
    expect(oc.mcp.add).toHaveBeenCalledTimes(2);

    // Second call: both alpha and beta are cached from the first call,
    // so no new adds. This is the path that recovers the ~12s/turn we
    // were burning before the cache existed.
    const reRegistered = await ensurePluginMcpServers(oc as never, "chat-1");
    expect(reRegistered).toEqual(["alpha", "beta"]);
    expect(oc.mcp.add).toHaveBeenCalledTimes(2);
  });

  it("ensureSession reuses a valid existing session and creates a new one when expired", async () => {
    const oc = makeClient();

    getSessionMock.mockReturnValueOnce({ sessionId: "existing-1" });
    oc.session.get.mockResolvedValueOnce({ data: { id: "existing-1" } });
    await expect(ensureSession(oc as never, "chat-a")).resolves.toBe(
      "existing-1",
    );
    expect(oc.session.create).not.toHaveBeenCalled();

    getSessionMock.mockReturnValueOnce({ sessionId: "expired-1" });
    oc.session.get.mockRejectedValueOnce(new Error("expired"));
    oc.session.create.mockResolvedValueOnce({ data: { id: "new-1" } });
    await expect(ensureSession(oc as never, "chat-a")).resolves.toBe("new-1");
    expect(resetSessionMock).toHaveBeenCalledWith("chat-a");
    expect(setSessionIdMock).toHaveBeenCalledWith("chat-a", "new-1");
  });

  it("ensureSession scopes the new session's permission ruleset to this chat's MCP server", async () => {
    // Per-session permission rules do two jobs:
    //   1. Hide other chats' MCP tools so a model in chat A can't call
    //      `talon-tools-<chatB>_send` (cross-chat leak / "No active
    //      chat context" gateway error).
    //   2. Auto-allow Kilo's built-ins (`read`, `bash`, `edit`) so
    //      they don't sit in `permission.asked` waiting for a reply
    //      that never comes — Talon's question watchdog only handles
    //      `question.*` events, not `permission.*`.
    // The deprecated per-prompt `tools` map and the previous
    // `permission.allowEverything` workaround are subsumed by this.
    const oc = makeClient();
    getSessionMock.mockReturnValueOnce({});
    oc.session.create.mockResolvedValueOnce({ data: { id: "new-perm-1" } });

    await ensureSession(oc as never, "chat/a");

    expect(oc.session.create).toHaveBeenCalledTimes(1);
    const args = oc.session.create.mock.calls[0][0] as {
      title?: string;
      permission?: Array<{
        permission: string;
        pattern: string;
        action: string;
      }>;
    };
    expect(args.title).toBe("Chat chat/a");
    expect(args.permission).toEqual([
      { permission: "tool", pattern: "talon-tools-chat_a_*", action: "allow" },
      { permission: "tool", pattern: "talon-tools-*", action: "deny" },
      { permission: "tool", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "allow" },
    ]);
  });

  it("disconnectChatMcpServer swallows disconnect errors", async () => {
    const oc = makeClient();
    oc.mcp.disconnect.mockRejectedValueOnce("boom");
    await expect(
      disconnectChatMcpServer(oc as never, "talon-tools-chat_1"),
    ).resolves.toBeUndefined();
  });

  it("resolveProviderID prefers matched providers and caches the result", async () => {
    const oc = makeClient();
    oc.provider.list.mockResolvedValue({
      data: {
        connected: [
          { id: "openai", models: { "gpt-5": { providerID: "openai" } } },
          { id: "fallback", models: { "gpt-5": {} } },
        ],
        configured: [{ id: "openai", models: { "gpt-5": {} } }],
        ignored: "not-an-array",
      },
    });

    await expect(resolveProviderID(oc as never, "gpt-5")).resolves.toBe(
      "openai",
    );
    await expect(resolveProviderID(oc as never, "gpt-5")).resolves.toBe(
      "openai",
    );
    expect(oc.provider.list).toHaveBeenCalledTimes(1);
  });

  it("resolveProviderID falls back to guessed provider when catalog has no model match", async () => {
    const oc = makeClient();
    oc.provider.list.mockResolvedValue({
      data: {
        connected: [{ id: "anthropic", models: { "claude-opus-4-7": {} } }],
      },
    });

    await expect(
      resolveProviderID(oc as never, "gemini-2.5-pro"),
    ).resolves.toBe("google");
  });

  it("parseStoredKiloModelSelection keeps non-kilo slug and trims whitespace", () => {
    expect(
      parseStoredKiloModelSelection("  openrouter/qwen3-235b-a22b:free  "),
    ).toEqual({
      providerID: undefined,
      modelID: "openrouter/qwen3-235b-a22b:free",
    });
  });

  it("parseStoredKiloModelSelection strips the leading kilo/ prefix and pins providerID", () => {
    // Talon stored `kilo/...` as a hint that the model is kilo-routed.
    // The Kilo upstream router doesn't want that prefix in the model id —
    // passing it through produces the bug surfaced in prod as
    // `Model not found: opencode/kilo/deepseek/deepseek-v4-flash:free`.
    expect(
      parseStoredKiloModelSelection(" kilo/deepseek/deepseek-v4-flash:free "),
    ).toEqual({
      providerID: "kilo",
      modelID: "deepseek/deepseek-v4-flash:free",
    });
  });
});
