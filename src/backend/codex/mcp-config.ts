/**
 * Convert Talon's MCP plugin map into Codex CLI's `--config` TOML
 * overrides.
 *
 * Codex's MCP support is configured at startup via `~/.codex/config.toml`
 * under the `mcp_servers.<name>` table, OR via per-process `--config`
 * overrides. The Codex SDK exposes the latter through
 * `CodexOptions.config` — a JSON object the SDK flattens into dotted
 * paths and serialises as TOML literals.
 *
 * Talon supplies MCP servers via `getPluginMcpServers(bridgeUrl, chatId)`
 * — a record of name → `{command, args, env}`. This module flattens
 * them into the shape Codex's CLI expects:
 *
 *   {
 *     mcp_servers: {
 *       <name>: { command: "node", args: [...], env: { ... } },
 *       ...
 *     }
 *   }
 *
 * The chat-specific Talon MCP server (`telegram-tools` etc.) and the
 * Brave Search server are added alongside the plugin servers.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { wrapMcpCommand } from "../../util/mcp-launcher.js";
import { getPluginMcpServers } from "../../core/plugin.js";

/** TOML-compatible record shape Codex's CLI accepts. */
export interface CodexMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Build the Codex `mcp_servers` config map for a given chat.
 *
 * Includes one frontend-tools server per non-terminal frontend (so the
 * agent can call `send` / `react` / `end_turn` etc.) plus all configured
 * plugin MCP servers. Brave Search is included as a special case when
 * configured, matching the Claude SDK backend's behaviour.
 */
export function buildCodexMcpServers(args: {
  chatId: string;
  bridgeUrl: string;
  frontends: readonly string[];
  braveApiKey?: string;
}): Record<string, CodexMcpServer> {
  const { chatId, bridgeUrl, frontends, braveApiKey } = args;

  // tsx as a Node loader is passed via `--import <url>`. Node accepts URLs
  // or absolute paths, but on Windows a raw backslash path is ambiguous
  // between path and URL; `pathToFileURL` produces a cross-platform
  // `file://` URL that Node always treats as a loader URL.
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

  const servers: Record<string, CodexMcpServer> = {};

  // Frontend MCP tool servers (one per non-terminal frontend).
  for (const frontend of frontends) {
    const serverName = `${frontend}-tools`;
    const wrapped = wrapMcpCommand([
      "node",
      "--import",
      tsxImport,
      mcpServerPath,
    ]);
    servers[serverName] = {
      command: wrapped[0],
      args: wrapped.slice(1),
      env: {
        TALON_BRIDGE_URL: bridgeUrl,
        TALON_CHAT_ID: chatId,
        TALON_FRONTEND: frontend,
      },
    };
  }

  // Brave Search MCP server (if configured).
  if (braveApiKey) {
    servers["brave-search"] = {
      command: resolve(
        import.meta.dirname ?? ".",
        "../../../node_modules/.bin/brave-search-mcp-server",
      ),
      args: [],
      env: { BRAVE_API_KEY: braveApiKey },
    };
  }

  // Plugin MCP servers.
  const pluginServers = getPluginMcpServers(bridgeUrl, chatId);
  for (const [name, cfg] of Object.entries(pluginServers)) {
    const wrapped = wrapMcpCommand([cfg.command, ...cfg.args]);
    servers[name] = {
      command: wrapped[0],
      args: wrapped.slice(1),
      env: cfg.env ?? {},
    };
  }

  return servers;
}
