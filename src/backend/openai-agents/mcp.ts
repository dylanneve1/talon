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
 * We resolve this at the Agent level via
 * `mcpConfig.includeServerInToolNames: true` (set in `handler.ts`).
 * The SDK then exposes each MCP tool as `mcp_<serverName>__<toolName>`,
 * so collisions are impossible by construction — Telegram's
 * `cancel_scheduled` becomes `mcp_telegram-tools__cancel_scheduled`,
 * email's becomes `mcp_email-tools__cancel_scheduled`, both stay
 * available to the model.
 *
 * The prior approach (callable `toolFilter` that first-claim-wins
 * dropped one side of any collision) was strictly worse: it lost
 * tools the model legitimately needed access to. Namespacing keeps
 * everything reachable; the only cost is longer tool identifiers in
 * the prompt, which capable models handle without issue.
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

  // Frontend MCP tool servers (one per non-terminal frontend). Each
  // exposes the Talon-native delivery surface (send, react, end_turn,
  // …) scoped to that frontend; the SDK's includeServerInToolNames
  // prefix gives them distinct identifiers so multi-frontend setups
  // (e.g. telegram + discord active simultaneously) don't collide on
  // shared tool names.
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

  // Plugin MCP servers — namespacing in the Agent's mcpConfig keeps
  // their tools distinct from the frontend's even when names overlap
  // (`cancel_scheduled`, `list_scheduled`, etc.).
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
