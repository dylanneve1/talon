/**
 * SDK options builder — constructs the configuration object for query() calls.
 *
 * Translates per-chat settings (model, effort) and global config (plugins,
 * MCP servers, system prompt) into the Options shape expected by the SDK.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Options,
  PostToolBatchHookInput,
  HookCallback,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { getSession } from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { getPluginMcpServers } from "../../core/plugin.js";
import { resolveModelId } from "../../core/models.js";
import { wrapMcpServer } from "../../util/mcp-launcher.js";
import { isTurnTerminator } from "../../core/tools/index.js";
import { log } from "../../util/log.js";
import { getConfig, getBridgePort } from "./state.js";
import { DISALLOWED_TOOLS_CHAT, EFFORT_MAP } from "./constants.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type BuildSdkOptionsResult = {
  options: Options;
  activeModel: string;
  session: ReturnType<typeof getSession>;
};

// ── MCP server construction ─────────────────────────────────────────────────

/**
 * Return the list of configured non-terminal frontends. Every entry here
 * corresponds to an MCP server spawned by `buildMcpServers` as
 * `${frontend}-tools` (e.g. `telegram-tools`, `teams-tools`).
 *
 * Returns an empty array when only `terminal` is configured (or when no
 * frontends are configured at all). Terminal mode has no outbound messaging
 * surface — the agent runs to stdout instead.
 *
 * Throws if the agent config hasn't been initialised (callers in test paths
 * should wrap in try/catch and treat as "no frontends available").
 */
export function getActiveFrontends(): readonly string[] {
  const config = getConfig();
  const allFrontends = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  return allFrontends.filter((f) => f !== "terminal");
}

/**
 * Build the MCP servers map for a chat query.
 * Includes frontend-specific tool servers and Brave Search, if configured.
 */
export function buildMcpServers(
  chatId: string,
): Record<
  string,
  { command: string; args: string[]; env: Record<string, string> }
> {
  const config = getConfig();
  const bridgeUrl = `http://127.0.0.1:${getBridgePort()}`;

  // tsx as a Node loader is passed via `--import <url>`. Node accepts URLs
  // or absolute paths, but on Windows a raw backslash path (`D:\…\tsx`) is
  // ambiguous between path and URL — the loader hook fails to register and
  // every subsequent `import` of a .ts file throws. `pathToFileURL` produces
  // a cross-platform `file://` URL that Node always treats as a loader URL.
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

  // Frontend-specific MCP tool servers (one per non-terminal frontend)
  const frontends = getActiveFrontends();

  const servers: Record<
    string,
    { command: string; args: string[]; env: Record<string, string> }
  > = {};

  for (const frontend of frontends) {
    const serverName = `${frontend}-tools`;
    const mcpEnv = {
      TALON_BRIDGE_URL: bridgeUrl,
      TALON_CHAT_ID: chatId,
      TALON_FRONTEND: frontend,
    };
    // `node --import <tsx-loader>` everywhere — tsx as a Node loader works
    // identically on Windows and POSIX, and avoids spawning `npx.cmd` (which
    // Node 20.19+ refuses to execute via child_process.spawn without
    // shell:true; CVE-2024-27980 mitigation). The wrapping launcher would
    // hit the same .cmd ban when calling its child.
    servers[serverName] = wrapMcpServer({
      command: "node",
      args: ["--import", tsxImport, mcpServerPath],
      env: mcpEnv,
    });
  }

  // Brave Search MCP server (if configured)
  if (config.braveApiKey) {
    servers["brave-search"] = wrapMcpServer({
      command: resolve(
        import.meta.dirname ?? ".",
        "../../../node_modules/.bin/brave-search-mcp-server",
      ),
      args: [],
      env: { BRAVE_API_KEY: config.braveApiKey },
    });
  }

  return servers;
}

// ── Hooks ───────────────────────────────────────────────────────────────────

/**
 * PostToolBatch hook: terminate the SDK query loop the moment a turn-terminator
 * tool (e.g. `end_turn`) resolves in the assistant's tool batch.
 *
 * Why PostToolBatch and not PostToolUse:
 *   - PostToolUse fires per-tool and may run concurrently for parallel tool
 *     calls. Returning `continue: false` from there can race with sibling MCP
 *     tools whose AbortControllers haven't yet completed — the same race that
 *     killed the previous `qi.interrupt()` approach (see handler.ts comment
 *     and commit `d5ce30f`).
 *   - PostToolBatch fires exactly ONCE after every tool in the batch has
 *     resolved. By definition there are no in-flight siblings to race with.
 *
 * What this saves:
 *   - The ~2-3s "phantom typing" round-trip the SDK makes after `end_turn`
 *     returns (the model has nothing to say, generates a stop_turn anyway).
 *   - Trailing prose that gets generated during that round-trip and was
 *     previously suppressed only at the delivery layer (real tokens spent).
 *
 * Returns `{ continue: false, stopReason: ... }` → SDK exits with TerminalReason
 * `'hook_stopped'`, no further model generation.
 */
const turnTerminatorHook: HookCallback = async (
  input,
): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== "PostToolBatch") {
    return { continue: true };
  }
  const batch = input as PostToolBatchHookInput;
  // Pass `tool_input` so the soft-terminator opt-out (e.g. react with
  // `end_turn: false`) can keep the loop alive. Without the input, the
  // check is name-only and reacts that meant to keep going would still
  // terminate.
  const terminator = batch.tool_calls.find((tc) =>
    isTurnTerminator(tc.tool_name, tc.tool_input),
  );
  if (terminator) {
    log(
      "agent",
      `PostToolBatch: terminating SDK loop on ${terminator.tool_name} ` +
        `(batch size: ${batch.tool_calls.length})`,
    );
    return {
      continue: false,
      stopReason: "turn terminated by end_turn / send",
    };
  }
  return { continue: true };
};

// ── Options builder ─────────────────────────────────────────────────────────

export function buildSdkOptions(chatId: string): BuildSdkOptionsResult {
  const config = getConfig();
  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.model;
  const activeEffort = chatSettings.effort ?? "adaptive";
  const resolvedActiveModel = resolveModelId(activeModel);

  const thinkingConfig = EFFORT_MAP[activeEffort] ?? {
    thinking: { type: "adaptive" as const },
  };

  const session = getSession(chatId);

  const options: Options = {
    model: resolvedActiveModel,
    systemPrompt: config.systemPrompt,
    cwd: config.workspace,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(config.claudeBinary
      ? { pathToClaudeCodeExecutable: config.claudeBinary }
      : {}),
    disallowedTools: [...DISALLOWED_TOOLS_CHAT],
    ...thinkingConfig,
    mcpServers: {
      ...buildMcpServers(chatId),
      ...getPluginMcpServers(`http://127.0.0.1:${getBridgePort()}`, chatId),
    },
    hooks: {
      PostToolBatch: [{ hooks: [turnTerminatorHook] }],
    },
    ...(session.sessionId ? { resume: session.sessionId } : {}),
  };

  return { options, activeModel, session };
}
