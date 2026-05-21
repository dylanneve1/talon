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
import type { CodexOptions } from "@openai/codex-sdk";
import { wrapMcpCommand } from "../../util/mcp-launcher.js";
import { getPluginMcpServers } from "../../core/plugin.js";

/**
 * AppToolApproval values accepted by Codex's `mcp_servers.<name>` table.
 *
 * Source: `codex-rs/config/src/mcp_types.rs` — the enum is `Auto | Prompt
 * | Approve` with `#[serde(rename_all = "snake_case")]`, so the wire
 * values are the lowercase strings below.
 *
 *   - `auto`    — Codex's default. Falls back to per-tool ToolAnnotations:
 *                 `read_only_hint=true` skips approval; otherwise
 *                 (no annotations, or `destructive_hint=true`, or
 *                 `open_world_hint=true`) approval is required.
 *   - `prompt`  — Approval is requested every time, regardless of
 *                 annotations.
 *   - `approve` — Auto-approve every call. `mcp_permission_prompt_is_auto_approved`
 *                 short-circuits to `true` for this server. Equivalent
 *                 to saying "Talon trusts this server, don't ask."
 */
export type CodexToolApprovalMode = "auto" | "prompt" | "approve";

/** TOML-compatible record shape Codex's CLI accepts. */
export interface CodexMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * Per-server default approval mode applied to every tool the server
   * exposes (unless a `tools.<tool>.approval_mode` override is set).
   *
   * Talon defaults all of its own MCP servers to `"approve"` because
   * Codex is run in non-interactive API mode here — there is no UI to
   * surface an approval prompt to. Without this, any tool whose schema
   * lacks `read_only_hint=true` (which is most of them) silently routes
   * through the approval flow, gets auto-cancelled, and surfaces as the
   * Rust-side `"user cancelled MCP tool call"` error.
   *
   * Serialised as `default_tools_approval_mode` in the TOML config.
   */
  default_tools_approval_mode?: CodexToolApprovalMode;
}

/**
 * Wrap a `Record<string, CodexMcpServer>` in the `{ mcp_servers: ... }`
 * envelope the Codex SDK expects on `CodexOptions.config`.
 *
 * The SDK's `CodexConfigObject` type recursively narrows values to
 * `string | number | boolean | array | object`. Our `CodexMcpServer`
 * shape satisfies that at runtime (every leaf is a string or string
 * array), but TypeScript can't prove the structural compatibility
 * because `Record<string, CodexMcpServer>` isn't a direct subtype of
 * the recursive `CodexConfigObject` type. The cast through `unknown`
 * is centralised here so the lie lives in exactly one documented spot
 * — both `init.ts` and any future caller use this helper.
 */
export function asCodexConfig(
  mcpServers: Record<string, CodexMcpServer>,
): CodexOptions["config"] {
  return {
    mcp_servers: mcpServers,
  } as unknown as CodexOptions["config"];
}

/**
 * Default approval mode for Talon-spawned MCP servers running under
 * Codex. Every entry built by `buildCodexMcpServers` is tagged with
 * this so Codex's approval flow short-circuits — see the
 * `default_tools_approval_mode` doc on `CodexMcpServer` for the full
 * reasoning. Exposed as a module-level constant rather than a
 * literal-everywhere so behaviour changes happen in exactly one place.
 */
export const TALON_MCP_DEFAULT_APPROVAL: CodexToolApprovalMode = "approve";

/**
 * Build the Codex `mcp_servers` config map for a given chat.
 *
 * Includes one frontend-tools server per non-terminal frontend (so the
 * agent can call `send` / `react` / `end_turn` etc.) plus all configured
 * plugin MCP servers. Brave Search is included as a special case when
 * configured, matching the Claude SDK backend's behaviour.
 *
 * Every server is tagged with `default_tools_approval_mode: "approve"`
 * so Codex auto-approves every tool call. Talon owns these servers
 * (they're spawned with our launcher and either talk to our own
 * bridge or to a trusted upstream the user has configured), and
 * Codex's non-interactive API mode has no UI to surface approval
 * prompts on — the previous default of `auto` was silently routing
 * any tool lacking a `read_only_hint=true` schema annotation through
 * the approval flow, where it would be auto-cancelled with the
 * Rust-side error `"user cancelled MCP tool call"`.
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
      default_tools_approval_mode: TALON_MCP_DEFAULT_APPROVAL,
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
      default_tools_approval_mode: TALON_MCP_DEFAULT_APPROVAL,
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
      default_tools_approval_mode: TALON_MCP_DEFAULT_APPROVAL,
    };
  }

  return servers;
}
