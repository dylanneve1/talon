/**
 * Build `MCPServerStdio[]` for the OpenAI Agents SDK from Talon's
 * plugin map.
 *
 * Unlike Codex (which wires MCP via `--config mcp_servers` TOML
 * overrides at thread-creation time) and Claude SDK (which passes
 * `{name: {command, args, env}}` records via the SDK options), the
 * OpenAI Agents SDK takes `MCPServerStdio` instances. Each instance
 * spawns the configured command as a subprocess, talks JSON-RPC over
 * stdio, and stays connected for the lifetime of the agent.
 *
 * Talon-side responsibility:
 *   - Construct one `MCPServerStdio` per frontend-tools server + per
 *     plugin server + brave-search (when configured).
 *   - `connect()` them in parallel before the agent run.
 *   - `close()` them in `finally` so subprocesses don't leak.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MCPServerStdio } from "@openai/agents";
import { wrapMcpCommand } from "../../util/mcp-launcher.js";
import { getPluginMcpServers } from "../../core/plugin.js";

/**
 * Build the MCP servers for a given chat. Returns connected
 * `MCPServerStdio` instances ready to pass into `new Agent({
 * mcpServers: [...] })`.
 *
 * Callers MUST `close()` each server when the agent run is finished,
 * otherwise the child processes leak. A small wrapper that returns
 * `{servers, close}` is provided below for convenience.
 */
export interface OpenAIAgentsMcpBundle {
  servers: MCPServerStdio[];
  /** Close all spawned subprocesses. Safe to call multiple times. */
  close: () => Promise<void>;
}

/**
 * Build + connect MCP servers for a chat. Spawning is parallel for
 * speed; if any single server fails to connect the others are still
 * closed cleanly.
 */
export async function buildOpenAIAgentsMcpServers(args: {
  chatId: string;
  bridgeUrl: string;
  frontends: readonly string[];
  braveApiKey?: string;
}): Promise<OpenAIAgentsMcpBundle> {
  const { chatId, bridgeUrl, frontends, braveApiKey } = args;

  // tsx as a Node loader is passed via `--import <url>`. Same
  // cross-platform `file://` URL handling as the other backends —
  // `pathToFileURL` produces a URL Node always treats as a loader URL.
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

  const servers: MCPServerStdio[] = [];

  // Frontend MCP tool servers (one per non-terminal frontend).
  for (const frontend of frontends) {
    const wrapped = wrapMcpCommand([
      "node",
      "--import",
      tsxImport,
      mcpServerPath,
    ]);
    servers.push(
      new MCPServerStdio({
        name: `${frontend}-tools`,
        command: wrapped[0],
        args: wrapped.slice(1),
        env: {
          TALON_BRIDGE_URL: bridgeUrl,
          TALON_CHAT_ID: chatId,
          TALON_FRONTEND: frontend,
        },
      }),
    );
  }

  // Brave Search MCP server (if configured).
  if (braveApiKey) {
    const braveCommand = resolve(
      import.meta.dirname ?? ".",
      "../../../node_modules/.bin/brave-search-mcp-server",
    );
    servers.push(
      new MCPServerStdio({
        name: "brave-search",
        command: braveCommand,
        args: [],
        env: { BRAVE_API_KEY: braveApiKey },
      }),
    );
  }

  // Plugin MCP servers.
  const pluginServers = getPluginMcpServers(bridgeUrl, chatId);
  for (const [name, cfg] of Object.entries(pluginServers)) {
    const wrapped = wrapMcpCommand([cfg.command, ...cfg.args]);
    servers.push(
      new MCPServerStdio({
        name,
        command: wrapped[0],
        args: wrapped.slice(1),
        env: cfg.env ?? {},
      }),
    );
  }

  // Connect all in parallel. If any single connect throws, close the
  // others we already connected (Promise.allSettled gives us per-
  // server outcomes) and surface the first error.
  const settled = await Promise.allSettled(servers.map((s) => s.connect()));
  const firstError = settled.find((r) => r.status === "rejected");
  if (firstError && firstError.status === "rejected") {
    // Best-effort close of any that did connect.
    await Promise.allSettled(servers.map((s) => s.close()));
    throw firstError.reason instanceof Error
      ? firstError.reason
      : new Error(String(firstError.reason));
  }

  const close = async (): Promise<void> => {
    await Promise.allSettled(servers.map((s) => s.close()));
  };

  return { servers, close };
}
