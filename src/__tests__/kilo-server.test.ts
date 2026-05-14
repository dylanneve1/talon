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
  initOpenCodeAgent,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  ensureSession,
  resolveProviderID,
  parseStoredOpenCodeModelSelection,
  stopOpenCodeServer,
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
};

function makeClient(): MockKiloClient {
  return {
    mcp: { status: vi.fn(), add: vi.fn(), disconnect: vi.fn() },
    tool: { ids: vi.fn() },
    session: { get: vi.fn(), create: vi.fn() },
    provider: { list: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stopOpenCodeServer();
  getSessionMock.mockReturnValue({});
  getPluginMcpServersMock.mockReturnValue({});
  initOpenCodeAgent({} as never, () => 17777, "discord");
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

  it("ensureChatMcpServer returns existing connected server without adding", async () => {
    const oc = makeClient();
    oc.mcp.status.mockResolvedValue({
      data: { "talon-tools-chat_1": { status: "connected" } },
    });

    const serverName = await ensureChatMcpServer(oc as never, "chat/1");

    expect(serverName).toBe("talon-tools-chat_1");
    expect(oc.mcp.add).not.toHaveBeenCalled();
  });

  it("ensureChatMcpServer registers server when not connected", async () => {
    const oc = makeClient();
    oc.mcp.status.mockResolvedValue({
      data: { "talon-tools-chat_1": { status: "disconnected" } },
    });

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

  it("ensurePluginMcpServers keeps connected servers and registers missing ones", async () => {
    const oc = makeClient();
    getPluginMcpServersMock.mockReturnValue({
      alpha: { command: "node", args: ["alpha.js"], env: { A: "1" } },
      beta: { command: "node", args: ["beta.js"], env: { B: "1" } },
    });
    oc.mcp.status.mockResolvedValue({
      data: { alpha: { status: "connected" } },
    });

    const registered = await ensurePluginMcpServers(oc as never, "chat-1");

    expect(registered).toEqual(["alpha", "beta"]);
    expect(oc.mcp.add).toHaveBeenCalledTimes(1);
    expect(oc.mcp.add.mock.calls[0][0]).toMatchObject({
      name: "beta",
      config: {
        command: ["node", "beta.js"],
        environment: { B: "1" },
      },
    });
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

  it("parseStoredOpenCodeModelSelection keeps full slug and trims whitespace", () => {
    expect(
      parseStoredOpenCodeModelSelection("  openrouter/qwen3-235b-a22b:free  "),
    ).toEqual({
      providerID: undefined,
      modelID: "openrouter/qwen3-235b-a22b:free",
    });
  });
});
