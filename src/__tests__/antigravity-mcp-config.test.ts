/**
 * Antigravity MCP-config builder tests.
 */

import { describe, it, expect, vi } from "vitest";
import { buildAntigravityMcpServers } from "../backend/antigravity/mcp-config.js";

vi.mock("../core/plugin.js", () => ({
  getPluginMcpServers: vi.fn(() => ({
    "test-plugin": {
      command: "node",
      args: ["/fake/test-plugin/index.js"],
      env: { TEST_VAR: "1" },
    },
  })),
}));

describe("antigravity / buildAntigravityMcpServers", () => {
  it("emits one frontend-tools server per active frontend", () => {
    const servers = buildAntigravityMcpServers({
      chatId: "chat-123",
      bridgeUrl: "http://127.0.0.1:8765",
      frontends: ["telegram"],
    });
    const ftServers = servers.filter((s) => s.name.endsWith("-tools"));
    expect(ftServers.length).toBe(1);
    expect(ftServers[0].name).toBe("telegram-tools");
    expect(ftServers[0].env).toMatchObject({
      TALON_BRIDGE_URL: "http://127.0.0.1:8765",
      TALON_CHAT_ID: "chat-123",
      TALON_FRONTEND: "telegram",
    });
  });

  it("includes Brave Search when an API key is configured", () => {
    const servers = buildAntigravityMcpServers({
      chatId: "chat-x",
      bridgeUrl: "http://127.0.0.1:1",
      frontends: ["telegram"],
      braveApiKey: "abc-key",
    });
    const brave = servers.find((s) => s.name === "brave-search");
    expect(brave).toBeDefined();
    expect(brave?.env?.BRAVE_API_KEY).toBe("abc-key");
  });

  it("omits Brave Search when no API key is set", () => {
    const servers = buildAntigravityMcpServers({
      chatId: "chat-x",
      bridgeUrl: "http://127.0.0.1:1",
      frontends: ["telegram"],
    });
    expect(servers.find((s) => s.name === "brave-search")).toBeUndefined();
  });

  it("includes plugin MCP servers", () => {
    const servers = buildAntigravityMcpServers({
      chatId: "chat-x",
      bridgeUrl: "http://127.0.0.1:1",
      frontends: ["telegram"],
    });
    const plugin = servers.find((s) => s.name === "test-plugin");
    expect(plugin).toBeDefined();
    expect(plugin?.env?.TEST_VAR).toBe("1");
  });

  it("supports multiple frontends with separate -tools servers", () => {
    const servers = buildAntigravityMcpServers({
      chatId: "chat-x",
      bridgeUrl: "http://127.0.0.1:1",
      frontends: ["telegram", "discord"],
    });
    expect(servers.some((s) => s.name === "telegram-tools")).toBe(true);
    expect(servers.some((s) => s.name === "discord-tools")).toBe(true);
  });
});
