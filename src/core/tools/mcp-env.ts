/**
 * Talon MCP server environment — the single place that defines the
 * env-var contract between backends (which spawn `mcp-server.ts` as a
 * subprocess) and the server itself (which reads these vars at boot).
 *
 * Before this helper, four backends (claude-sdk, codex, openai-agents,
 * kilo/opencode via remote-server) each hand-built the same
 * `{TALON_BRIDGE_URL, TALON_CHAT_ID, TALON_FRONTEND}` literal —
 * adding a variable meant editing all four. Now they call
 * `buildTalonMcpEnv` and new vars propagate everywhere.
 *
 * Tool-surface trimming: every registered MCP tool costs context
 * tokens in EVERY session (name + description + schema). Deployments
 * that never use whole tool groups (stickers, polls, triggers, …) can
 * reclaim that budget via `disabledToolTags` / `disabledTools` in
 * talon.json — carried to the subprocess as comma-separated env vars.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Env-var names (shared constants, not stringly-typed call sites) ────────

export const ENV_BRIDGE_URL = "TALON_BRIDGE_URL";
export const ENV_CHAT_ID = "TALON_CHAT_ID";
export const ENV_FRONTEND = "TALON_FRONTEND";
export const ENV_DISABLED_TOOLS = "TALON_DISABLED_TOOLS";
export const ENV_DISABLED_TOOL_TAGS = "TALON_DISABLED_TOOL_TAGS";

// ── Builder (backend side) ──────────────────────────────────────────────────

/** The slice of TalonConfig the MCP env cares about. */
export type ToolExclusionConfig = {
  disabledTools?: readonly string[];
  disabledToolTags?: readonly string[];
};

export type TalonMcpEnvInputs = {
  bridgeUrl: string;
  chatId: string;
  frontend: string;
  /** Pass the Talon config (or the exclusion slice of it) when available. */
  config?: ToolExclusionConfig | null;
};

/** Build the env map for spawning Talon's unified MCP tool server. */
export function buildTalonMcpEnv(
  inputs: TalonMcpEnvInputs,
): Record<string, string> {
  const env: Record<string, string> = {
    [ENV_BRIDGE_URL]: inputs.bridgeUrl,
    [ENV_CHAT_ID]: inputs.chatId,
    [ENV_FRONTEND]: inputs.frontend,
  };
  const tools = inputs.config?.disabledTools;
  if (tools?.length) env[ENV_DISABLED_TOOLS] = tools.join(",");
  const tags = inputs.config?.disabledToolTags;
  if (tags?.length) env[ENV_DISABLED_TOOL_TAGS] = tags.join(",");
  return env;
}

// ── Spawn spec ──────────────────────────────────────────────────────────────

/**
 * The command line that launches Talon's unified MCP tool server.
 *
 * tsx as a Node loader is passed via `--import <file-url>`: Node
 * accepts URLs or absolute paths, but on Windows a raw backslash path
 * is ambiguous between path and URL — `pathToFileURL` always parses
 * as a loader URL. `node --import` (vs spawning `npx`/`tsx` directly)
 * also sidesteps the Node 20.19+ refusal to spawn `.cmd` shims
 * without `shell: true` (CVE-2024-27980 mitigation).
 *
 * Returns a fresh array: callers wrap it in their own supervisor
 * (`wrapMcpServer` / `wrapMcpCommand`) and may mutate it.
 */
export function talonMcpServerCommand(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const tsxImport = pathToFileURL(
    resolve(here, "../../../node_modules/tsx/dist/esm/index.mjs"),
  ).href;
  return ["node", "--import", tsxImport, resolve(here, "mcp-server.ts")];
}

// ── Parser (server side) ────────────────────────────────────────────────────

/** Parse a comma-separated env var into a trimmed, de-blanked list. */
export function parseEnvList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
