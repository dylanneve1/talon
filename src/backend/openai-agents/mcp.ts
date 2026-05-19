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
import type { MCPToolFilterCallable } from "@openai/agents";
import { wrapMcpCommand } from "../../util/mcp-launcher.js";
import { getPluginMcpServers } from "../../core/plugin.js";
import { logDebug } from "../../util/log.js";

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
 *
 * Tool-name collisions
 * ────────────────────
 *
 * The OpenAI Agents SDK refuses to register two MCP servers that
 * expose the same tool name (`Duplicate tool names found across MCP
 * servers: ...`). Talon legitimately ships colliding names — the
 * frontend MCP server and the email plugin both expose
 * `cancel_scheduled`, for example — because they're scoped to
 * different domains (cancel a scheduled Telegram message vs. a
 * scheduled email).
 *
 * We resolve this with a shared first-claimer filter: each server
 * gets a callable `toolFilter` that consults a closure-owned
 * `ownerByTool` map. Whichever server lists a given tool name
 * **first** keeps it; subsequent servers have that name silently
 * dropped from their visible toolset. Server priority is the order
 * we append to `servers` below — frontend tools first, then
 * Brave Search, then plugin servers in iteration order. So when
 * Telegram and email both claim `cancel_scheduled`, Telegram wins
 * (frontend before plugins).
 *
 * Idempotent on re-list: the map persists for the lifetime of the
 * bundle, so a re-`listTools()` re-applies the same ownership.
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

  // Shared "first claimer" map (toolName → serverName). All servers
  // share the same instance via the filter closure below, so first
  // server to list a given tool name keeps exclusive ownership for
  // the rest of the bundle's lifetime.
  const ownerByTool = new Map<string, string>();
  const makeDedupFilter = (): MCPToolFilterCallable => {
    return async (ctx, tool) => {
      const owner = ownerByTool.get(tool.name);
      if (!owner) {
        ownerByTool.set(tool.name, ctx.serverName);
        return true;
      }
      const ours = owner === ctx.serverName;
      if (!ours) {
        logDebug(
          "agent",
          `MCP tool dedup: dropped ${tool.name} from ${ctx.serverName} (claimed by ${owner})`,
        );
      }
      return ours;
    };
  };

  const servers: MCPServerStdio[] = [];

  // Frontend MCP tool servers (one per non-terminal frontend).
  // Frontend wins all name conflicts — these are the Talon-native
  // tools (send, react, end_turn, …) and must always be available.
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
        toolFilter: makeDedupFilter(),
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
        toolFilter: makeDedupFilter(),
      }),
    );
  }

  // Plugin MCP servers — last in priority. If a plugin's tool name
  // collides with the frontend's, the frontend version wins.
  const pluginServers = getPluginMcpServers(bridgeUrl, chatId);
  for (const [name, cfg] of Object.entries(pluginServers)) {
    const wrapped = wrapMcpCommand([cfg.command, ...cfg.args]);
    servers.push(
      new MCPServerStdio({
        name,
        command: wrapped[0],
        args: wrapped.slice(1),
        env: cfg.env ?? {},
        toolFilter: makeDedupFilter(),
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
