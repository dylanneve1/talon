/**
 * MCP server config — build the Claude Agent SDK MCP server map for plugins
 * that expose an MCP server (via `mcpServer` command/args or `mcpServerPath`),
 * plus the standalone MCP entries from config.
 */

import { resolve } from "node:path";
import { wrapMcpServer } from "../../util/mcp-launcher.js";
import { registry, reloadState } from "./registry.js";
import type { McpServerConfig } from "./types.js";

function buildBridgeEnv(
  bridgeUrl: string,
  chatId: string,
  envVars?: Record<string, string>,
): Record<string, string> {
  return {
    ...envVars,
    TALON_BRIDGE_URL: bridgeUrl,
    TALON_CHAT_ID: chatId,
    TALON_RELOAD_AT: reloadState.lastReloadAt,
  };
}

/**
 * Build MCP server entries for plugins that provide an MCP server.
 * Plugins can expose an MCP server in two ways:
 *   - `mcpServerPath` — path to a Node/TypeScript MCP server script (run via tsx)
 *   - `mcpServer` — custom command/args for non-Node servers (Python, Go, etc.)
 * Plugins with neither are skipped. When both are set, `mcpServer` takes priority.
 *
 * @param only — optional list of plugin names to include. If omitted, all
 *   plugins with MCP servers are returned. Pass `[]` to get none.
 */
export function getPluginMcpServers(
  bridgeUrl: string,
  chatId: string,
  only?: string[],
): Record<string, McpServerConfig> {
  if (only !== undefined && only.length === 0) return {};

  const servers: Record<string, McpServerConfig> = {};

  // Resolve tsx from Talon's own node_modules (not cwd which may be ~/.talon/workspace/)
  const tsxPath = resolve(
    import.meta.dirname,
    "../../../node_modules/tsx/dist/esm/index.mjs",
  );

  for (const { plugin, envVars } of registry.all) {
    // Skip plugins not in the allow-list when filtering
    if (only !== undefined && !only.includes(plugin.name)) continue;
    const baseEnv = buildBridgeEnv(bridgeUrl, chatId, envVars);

    if (plugin.mcpServer) {
      // Custom command/args (Python, Go, etc.) — no tsx wrapper
      servers[`${plugin.name}-tools`] = wrapMcpServer({
        command: plugin.mcpServer.command,
        args: [...plugin.mcpServer.args],
        env: baseEnv,
      });
    } else if (plugin.mcpServerPath) {
      // Existing Node/tsx pattern
      servers[`${plugin.name}-tools`] = wrapMcpServer({
        command: process.platform === "win32" ? "npx" : "node",
        args:
          process.platform === "win32"
            ? ["tsx", plugin.mcpServerPath]
            : ["--import", tsxPath, plugin.mcpServerPath],
        env: baseEnv,
      });
    }
  }

  // Include standalone MCP server entries from config
  for (const entry of registry.mcpEntries) {
    if (only !== undefined && !only.includes(entry.name)) continue;
    servers[`${entry.name}-tools`] = wrapMcpServer({
      command: entry.command,
      args: [...(entry.args ?? [])],
      env: buildBridgeEnv(bridgeUrl, chatId, entry.env),
    });
  }

  return servers;
}
