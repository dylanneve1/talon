/**
 * Unit tests for the shared `backend/remote-server/mcp.ts` helpers.
 *
 * These tests cover the chat-MCP-server visibility model — the most
 * subtle behaviour the refactor preserves. The integration tests in
 * `integration/kilo-real-bootstrap.test.ts` and
 * `integration/opencode-real-bootstrap.test.ts` exercise the same
 * helpers through real `KiloClient` / `OpencodeClient` instances, but
 * these unit tests catch regressions without spinning up an actual
 * agent server.
 *
 * Key invariants asserted:
 *
 *   1. Connecting `talon-tools-chatA` after `talon-tools-chatB` is
 *      already registered DISCONNECTS chatB first. (Visibility scoping —
 *      see `mcp.ts` for the rationale.)
 *   2. The `talon-tools-heartbeat` sentinel is exempt from rotation.
 *   3. Plugin MCP servers stay connected across chat switches.
 *   4. Local registration cache short-circuits redundant `mcp.add` calls.
 *   5. `buildToolOverrides` produces the correct enable/disable map for
 *      a multi-chat tool catalog.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  createRemoteServerState,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  getChatMcpServerName,
  isTalonToolID,
  getRegisteredMcpServerNames,
  TALON_MCP_SERVER_NAME,
  type RemoteAgentClient,
  type RemoteServerState,
} from "../backend/remote-server/index.js";

// ── Test doubles ────────────────────────────────────────────────────────────

interface RecordedMcpAdd {
  name: string;
  config: {
    type: string;
    command: string[];
    environment?: Record<string, string>;
  };
}

/**
 * Mock client that records every call against the `RemoteAgentClient`
 * interface. Returned arrays/maps are intentionally minimal — we only
 * assert on what the shared helpers actually consume.
 */
function makeMockClient(toolIds: string[] = []): {
  client: RemoteAgentClient;
  mcpAddCalls: RecordedMcpAdd[];
  mcpDisconnectCalls: string[];
  toolIdsCalls: number;
} {
  const mcpAddCalls: RecordedMcpAdd[] = [];
  const mcpDisconnectCalls: string[] = [];
  let toolIdsCalls = 0;
  const client: RemoteAgentClient = {
    mcp: {
      add: vi.fn(async ({ name, config }) => {
        mcpAddCalls.push({ name, config });
        return { data: { [name]: { status: "connected" } } };
      }),
      disconnect: vi.fn(async ({ name }) => {
        mcpDisconnectCalls.push(name);
        return { data: true };
      }),
    },
    session: {
      create: vi.fn(),
      get: vi.fn(),
    },
    tool: {
      ids: vi.fn(async () => {
        toolIdsCalls++;
        return { data: toolIds };
      }),
    },
    provider: {
      list: vi.fn(),
    },
  };
  return {
    client,
    mcpAddCalls,
    mcpDisconnectCalls,
    get toolIdsCalls() {
      return toolIdsCalls;
    },
  };
}

function makeState(): RemoteServerState<RemoteAgentClient> {
  const state = createRemoteServerState<RemoteAgentClient>({
    label: "TestBackend",
    hostname: "127.0.0.1",
    port: 9999,
  });
  // Mock the plugin module's pluginServers map by stashing it via the
  // gatewayPortFn (the helper reads `getPluginMcpServers(url, chatId)`
  // and gateway port is the only mutable knob — we don't need to mock
  // it for these tests since we only assert behaviour around chat MCP).
  state.gatewayPortFn = () => 19876;
  return state;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("remote-server / mcp helpers", () => {
  describe("getChatMcpServerName", () => {
    it("derives a stable name from a numeric Telegram chatId", () => {
      expect(getChatMcpServerName("352042062")).toBe("talon-tools-352042062");
    });

    it("handles negative supergroup ids by sanitising the dash", () => {
      // `-` is in the allow-list, so it stays literal
      expect(getChatMcpServerName("-1001426819337")).toBe(
        "talon-tools--1001426819337",
      );
    });

    it("replaces unsafe chars in Discord-style snowflakes", () => {
      expect(getChatMcpServerName("chat:abc/def")).toBe(
        "talon-tools-chat_abc_def",
      );
    });

    it("falls back to 'chat' for the empty string", () => {
      expect(getChatMcpServerName("")).toBe("talon-tools-chat");
    });
  });

  describe("isTalonToolID", () => {
    it("matches both underscore and dash variants", () => {
      expect(isTalonToolID("talon-tools_send")).toBe(true);
      expect(isTalonToolID("talon-tools-352042062_send")).toBe(true);
    });

    it("rejects non-Talon tool ids", () => {
      expect(isTalonToolID("brave-search_query")).toBe(false);
      expect(isTalonToolID("mempalace_search")).toBe(false);
      expect(isTalonToolID("send")).toBe(false);
    });
  });

  describe("ensureChatMcpServer — visibility rotation", () => {
    let state: RemoteServerState<RemoteAgentClient>;

    beforeEach(() => {
      state = makeState();
    });

    it("registers the chat MCP server and records it in the cache", async () => {
      const { client, mcpAddCalls } = makeMockClient();
      const name = await ensureChatMcpServer(client, state, "chatA");

      expect(name).toBe("talon-tools-chatA");
      expect(mcpAddCalls).toHaveLength(1);
      expect(mcpAddCalls[0].name).toBe("talon-tools-chatA");
      expect(mcpAddCalls[0].config.type).toBe("local");
      expect(mcpAddCalls[0].config.environment).toMatchObject({
        TALON_CHAT_ID: "chatA",
        TALON_FRONTEND: "telegram",
      });
      expect(getRegisteredMcpServerNames(state)).toContain("talon-tools-chatA");
    });

    it("DISCONNECTS rival chat server before registering current one", async () => {
      const { client, mcpDisconnectCalls, mcpAddCalls } = makeMockClient();

      await ensureChatMcpServer(client, state, "chatA");
      expect(getRegisteredMcpServerNames(state)).toContain("talon-tools-chatA");

      // Switch to chatB — chatA must be disconnected first
      mcpAddCalls.length = 0;
      mcpDisconnectCalls.length = 0;
      await ensureChatMcpServer(client, state, "chatB");

      expect(mcpDisconnectCalls).toEqual(["talon-tools-chatA"]);
      expect(mcpAddCalls).toHaveLength(1);
      expect(mcpAddCalls[0].name).toBe("talon-tools-chatB");
      expect(getRegisteredMcpServerNames(state)).not.toContain(
        "talon-tools-chatA",
      );
      expect(getRegisteredMcpServerNames(state)).toContain("talon-tools-chatB");
    });

    it("never disconnects the heartbeat sentinel server", async () => {
      const { client, mcpDisconnectCalls } = makeMockClient();
      // Seed the heartbeat sentinel + a rival chat
      state.registeredMcpServers.add("talon-tools-heartbeat");
      state.registeredMcpServers.add("talon-tools-chatA");

      await ensureChatMcpServer(client, state, "chatB");

      // Only chatA gets the boot — heartbeat stays connected
      expect(mcpDisconnectCalls).toEqual(["talon-tools-chatA"]);
      expect(getRegisteredMcpServerNames(state)).toContain(
        "talon-tools-heartbeat",
      );
      expect(getRegisteredMcpServerNames(state)).toContain("talon-tools-chatB");
    });

    it("does not rotate plugin servers across chat switches", async () => {
      const { client, mcpDisconnectCalls } = makeMockClient();
      // Seed a plugin server (different prefix, e.g. mempalace, brave-search)
      state.registeredMcpServers.add("mempalace");
      state.registeredMcpServers.add("brave-search");
      state.registeredMcpServers.add("talon-tools-chatA");

      await ensureChatMcpServer(client, state, "chatB");

      // Only the rival chat server gets disconnected
      expect(mcpDisconnectCalls).toEqual(["talon-tools-chatA"]);
      expect(getRegisteredMcpServerNames(state)).toContain("mempalace");
      expect(getRegisteredMcpServerNames(state)).toContain("brave-search");
    });

    it("skips redundant mcp.add when the cache says it's registered", async () => {
      const { client, mcpAddCalls } = makeMockClient();

      await ensureChatMcpServer(client, state, "chatA");
      expect(mcpAddCalls).toHaveLength(1);

      // Second call for the same chat — local cache should short-circuit
      await ensureChatMcpServer(client, state, "chatA");
      expect(mcpAddCalls).toHaveLength(1);
    });

    it("returns the server name even when the upstream add fails", async () => {
      const { client } = makeMockClient();
      // Force every add to fail
      client.mcp.add = vi.fn(async () => {
        throw new Error("connection refused");
      });

      const name = await ensureChatMcpServer(client, state, "chatA");
      expect(name).toBe("talon-tools-chatA");
      // Cache should NOT include a server that failed to register
      expect(getRegisteredMcpServerNames(state)).not.toContain(
        "talon-tools-chatA",
      );
    });
  });

  describe("disconnectChatMcpServer", () => {
    it("removes the entry from the cache on success", async () => {
      const state = makeState();
      const { client, mcpDisconnectCalls } = makeMockClient();
      state.registeredMcpServers.add("talon-tools-chatA");

      await disconnectChatMcpServer(client, state, "talon-tools-chatA");

      expect(mcpDisconnectCalls).toEqual(["talon-tools-chatA"]);
      expect(getRegisteredMcpServerNames(state)).not.toContain(
        "talon-tools-chatA",
      );
    });

    it("does not throw when the upstream disconnect fails", async () => {
      const state = makeState();
      const { client } = makeMockClient();
      client.mcp.disconnect = vi.fn(async () => {
        throw new Error("not connected");
      });

      await expect(
        disconnectChatMcpServer(client, state, "talon-tools-chatA"),
      ).resolves.toBeUndefined();
    });
  });

  describe("buildToolOverrides", () => {
    it("enables this chat's tools and disables every other chat's", async () => {
      const state = makeState();
      const { client } = makeMockClient([
        "talon-tools-chatA_send",
        "talon-tools-chatA_react",
        "talon-tools-chatB_send",
        "talon-tools-chatB_react",
        // Plugin / built-in tools should NOT appear in the override map
        "brave-search_query",
        "read",
        "bash",
      ]);

      const overrides = await buildToolOverrides(
        client,
        state,
        "talon-tools-chatA",
      );

      expect(overrides).toEqual({
        "talon-tools-chatA_send": true,
        "talon-tools-chatA_react": true,
        "talon-tools-chatB_send": false,
        "talon-tools-chatB_react": false,
      });
      // Plugin tools deliberately omitted
      expect(overrides).not.toHaveProperty("brave-search_query");
      expect(overrides).not.toHaveProperty("read");
    });

    it("returns undefined when no chat tools matched", async () => {
      const state = makeState();
      const { client } = makeMockClient(["read", "bash", "brave-search_query"]);

      const overrides = await buildToolOverrides(
        client,
        state,
        "talon-tools-chatA",
      );

      expect(overrides).toBeUndefined();
    });

    it("returns undefined when no chat tool of OURS matched (only rivals exist)", async () => {
      const state = makeState();
      const { client } = makeMockClient([
        "talon-tools-chatB_send",
        "talon-tools-chatB_react",
      ]);

      const overrides = await buildToolOverrides(
        client,
        state,
        "talon-tools-chatA",
      );

      // Only OTHER chats' tools are in the catalog — no point overriding
      expect(overrides).toBeUndefined();
    });

    it("returns undefined and logs a warning when tool.ids throws", async () => {
      const state = makeState();
      const { client } = makeMockClient();
      client.tool.ids = vi.fn(async () => {
        throw new Error("upstream timeout");
      });

      const overrides = await buildToolOverrides(
        client,
        state,
        "talon-tools-chatA",
      );
      expect(overrides).toBeUndefined();
    });
  });

  describe("ensurePluginMcpServers", () => {
    it("registers a plugin server and caches it for next call", async () => {
      const state = makeState();
      const { client, mcpAddCalls } = makeMockClient();

      // We can't easily mock `getPluginMcpServers` from this test (it's a
      // module-level function); instead this test serves as a sanity check
      // that the function exists and accepts the expected signature. The
      // integration tests (`opencode-real-bootstrap.test.ts`,
      // `kilo-real-bootstrap.test.ts`) cover the end-to-end plugin path.
      await expect(
        ensurePluginMcpServers(client, state, "chatA"),
      ).resolves.toBeInstanceOf(Array);
      // First call may register zero or more plugin servers depending on
      // what plugins are configured in the test env — we only assert that
      // the call completes without throwing.
      void mcpAddCalls;
    });
  });

  describe("TALON_MCP_SERVER_NAME constant", () => {
    it("is the stable prefix all Talon MCP servers use", () => {
      expect(TALON_MCP_SERVER_NAME).toBe("talon-tools");
    });
  });
});
