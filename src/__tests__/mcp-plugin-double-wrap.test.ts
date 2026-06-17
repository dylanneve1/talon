/**
 * Regression: plugin MCP servers must not be double-wrapped.
 *
 * `getPluginMcpServers()` (core/plugin.ts) already runs every plugin
 * command through the supervisor wrap (`wrapMcpServer`), so the
 * command/args it returns are launcher-ready. The per-backend MCP config
 * builders must therefore pass those through UNCHANGED.
 *
 * Previously codex / openai-agents / remote-server re-applied
 * `wrapMcpCommand(...)` on top, producing a
 * `[supervisor, …, supervisor, …, realCmd]` double-wrap that broke plugin
 * MCP servers (the inner supervisor was launched as if it were the server).
 * claude-sdk already consumed the map raw, which is the correct contract.
 *
 * kilo and opencode are covered transitively: both route plugin servers
 * through the shared `remote-server` `ensurePluginMcpServers` path.
 *
 * This test pins the contract on the codex builder (a pure, synchronous
 * function): a plugin entry that is already launcher-shaped must come out
 * byte-identical — no second wrapper prepended.
 */

import { describe, it, expect, vi } from "vitest";

// Stand-in for a getPluginMcpServers() entry: already wrapped by
// wrapMcpServer, i.e. the real command runs under the Talon supervisor.
const LAUNCHER_READY = {
  "mempalace-tools": {
    command: "node",
    args: [
      "--import",
      "/talon/node_modules/tsx/dist/esm/index.mjs",
      "/talon/dist/mcp-launch.js",
      "python",
      "-m",
      "mempalace.mcp_server",
    ],
    env: { MEMPALACE_PATH: "/palace" },
  },
};

vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: vi.fn(() => structuredClone(LAUNCHER_READY)),
}));

import { buildCodexMcpServers } from "../backend/codex/mcp-config.js";

describe("plugin MCP servers are not double-wrapped", () => {
  it("codex passes the launcher-ready command/args through unchanged", () => {
    const servers = buildCodexMcpServers({
      chatId: "c1",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: ["telegram"],
    });

    const plugin = servers["mempalace-tools"];
    expect(plugin).toBeDefined();

    const expected = LAUNCHER_READY["mempalace-tools"];
    // Exact pass-through: re-wrapping would replace `command` with the
    // supervisor binary and push the original command down into `args`.
    expect(plugin.command).toBe(expected.command);
    expect(plugin.args).toEqual(expected.args);

    // Belt-and-braces: the launcher entrypoint token must appear exactly
    // once across the final argv — a second wrap would duplicate it.
    const launcherHits = plugin.args.filter((a) =>
      a.includes("mcp-launch.js"),
    ).length;
    expect(launcherHits).toBe(1);
  });
});
