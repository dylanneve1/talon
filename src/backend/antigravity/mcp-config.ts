/**
 * Build the MCP server list to ship to the Antigravity Python bridge.
 *
 * The bridge spawns `McpStdioServer(name, command, args, env)` for each
 * entry. The shape mirrors Codex's MCP config builder — same list of
 * servers (frontend-tools per active frontend, Brave Search if
 * configured, all plugin MCPs).
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { wrapMcpCommand } from "../../util/mcp-launcher.js";
import { getPluginMcpServers } from "../../core/plugin.js";

export interface AntigravityMcpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function buildAntigravityMcpServers(args: {
  chatId: string;
  bridgeUrl: string;
  frontends: readonly string[];
  braveApiKey?: string;
}): AntigravityMcpServer[] {
  const { chatId, bridgeUrl, frontends, braveApiKey } = args;

  const tsxImport = pathToFileURL(
    resolve(
      import.meta.dirname ?? ".",
      "../../../node_modules/tsx/dist/esm/index.mjs",
    ),
  ).href;
  const mcpServerPath = resolve(
    import.meta.dirname ?? ".",
    "../../core/tools/mcp-server.ts",
  );

  const servers: AntigravityMcpServer[] = [];

  for (const frontend of frontends) {
    const serverName = `${frontend}-tools`;
    const wrapped = wrapMcpCommand([
      "node",
      "--import",
      tsxImport,
      mcpServerPath,
    ]);
    servers.push({
      name: serverName,
      command: wrapped[0],
      args: wrapped.slice(1),
      env: {
        TALON_BRIDGE_URL: bridgeUrl,
        TALON_CHAT_ID: chatId,
        TALON_FRONTEND: frontend,
      },
    });
  }

  if (braveApiKey) {
    servers.push({
      name: "brave-search",
      command: resolve(
        import.meta.dirname ?? ".",
        "../../../node_modules/.bin/brave-search-mcp-server",
      ),
      args: [],
      env: { BRAVE_API_KEY: braveApiKey },
    });
  }

  const pluginServers = getPluginMcpServers(bridgeUrl, chatId);
  for (const [name, cfg] of Object.entries(pluginServers)) {
    const wrapped = wrapMcpCommand([cfg.command, ...cfg.args]);
    servers.push({
      name,
      command: wrapped[0],
      args: wrapped.slice(1),
      env: cfg.env ?? {},
    });
  }

  return servers;
}
