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
  NotificationHookInput,
  StopFailureHookInput,
  HookCallback,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { getSession } from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { getPluginMcpServers } from "../../core/plugin.js";
import { resolveModelId } from "../../core/models.js";
import { wrapMcpServer } from "../../util/mcp-launcher.js";
import { isTurnTerminator } from "../../core/tools/index.js";
import { log, logError } from "../../util/log.js";
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

/**
 * Notification hook: log SDK-generated notifications (e.g. context compaction,
 * model switches, rate-limit advisories) that are otherwise silently dropped.
 *
 * These events fire asynchronously during a query session and carry a
 * `notification_type` string and a human-readable `message`. Surfacing them in
 * the agent log makes the lifecycle of a session visible — previously the only
 * evidence of compaction or a model switch was an increase in cache-write tokens
 * in the post-turn accounting line.
 *
 * Returns `{ continue: true }` — the hook is purely observational.
 */
const notificationHook: HookCallback = async (
  input,
): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== "Notification") {
    return { continue: true };
  }
  const n = input as NotificationHookInput;
  const titlePart = n.title ? ` [${n.title}]` : "";
  log(
    "agent",
    `[NOTIFICATION]${titlePart} type=${n.notification_type}: ${n.message}`,
  );
  return { continue: true };
};

/**
 * StopFailure hook: log SDK stop-failure events for error telemetry.
 *
 * `StopFailure` fires when the SDK loop exits abnormally — e.g. an API error
 * that bypasses the normal `result` message path. Without this hook the failure
 * is swallowed by the SDK and only the downstream catch block in handler.ts
 * sees it (as a thrown error), losing the `error_details` field that contains
 * the raw API response. Logging it here preserves the full context.
 *
 * Returns `{ continue: true }` — this hook cannot prevent the failure, only
 * record it.
 */
const stopFailureHook: HookCallback = async (
  input,
): Promise<HookJSONOutput> => {
  if (input.hook_event_name !== "StopFailure") {
    return { continue: true };
  }
  const sf = input as StopFailureHookInput;
  logError(
    "agent",
    `[STOP_FAILURE] error=${JSON.stringify(sf.error)}` +
      (sf.error_details ? ` details=${sf.error_details}` : ""),
  );
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
    // The SDK's permission system is designed for an interactive Claude
    // Code IDE session where a human approves each tool call. Talon runs
    // the SDK as a server-side bot — there's no human at the keyboard
    // to confirm Bash/Edit/etc., and our security boundary is the bot
    // account itself (its OS user, its workspace dir, its mempalace),
    // not the SDK's per-tool prompts. `bypassPermissions` skips the
    // interactive prompts; `allowDangerouslySkipPermissions` is the
    // explicit acknowledgement the SDK requires alongside it. Treat
    // these as a unit — flipping either alone is a configuration bug.
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
      Notification: [{ hooks: [notificationHook] }],
      StopFailure: [{ hooks: [stopFailureHook] }],
    },
    ...(session.sessionId ? { resume: session.sessionId } : {}),
  };

  return { options, activeModel, session };
}
