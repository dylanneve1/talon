/**
 * SDK options builder — constructs the configuration object for query() calls.
 *
 * Translates per-chat settings (model, effort) and global config (plugins,
 * MCP servers, system prompt) into the Options shape expected by the SDK.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  PostToolBatchHookInput,
  PostToolUseFailureHookInput,
  NotificationHookInput,
  StopFailureHookInput,
  HookCallback,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { PreparedSystemPrompt } from "../shared/system-prompt.js";
import { getSession } from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { getPluginMcpServers } from "../../core/plugin.js";
import { resolveModelId } from "../../core/models.js";
import { wrapMcpServer } from "../../util/mcp-launcher.js";
import { isTurnTerminator } from "../../core/tools/index.js";
import { log, logError } from "../../util/log.js";
import { getConfig, getBridgePort } from "./state.js";
import { ALLOWED_TOOLS_CHAT, EFFORT_MAP } from "./constants.js";

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
 * Build the turn-terminator hook pair (PostToolUseFailure + PostToolBatch).
 *
 * These two hooks coordinate through a per-session `Set<tool_use_id>` of
 * terminator tools whose `execute()` threw. The set is shared by closure —
 * one Set per `buildSdkOptions` call, so concurrent chat sessions never
 * leak failure flags into each other.
 *
 * Design choices:
 *
 * - **Why PostToolBatch for the terminate decision** (vs PostToolUse): batch
 *   fires exactly once after every tool in the batch has resolved, so there
 *   are no in-flight siblings to race with. PostToolUse fires per-tool and
 *   can race with sibling MCP tools whose AbortControllers haven't completed
 *   — the same race that killed the earlier `qi.interrupt()` approach (commit
 *   `d5ce30f`).
 *
 * - **Why also PostToolUseFailure**: when a terminator tool's `execute()`
 *   throws (e.g. `end_turn` throws because the bridge returned `{ok:false}`),
 *   the SDK fires PostToolUseFailure with `{tool_name, error, is_interrupt}`.
 *   That's a typed, content-free signal that the call failed — vastly more
 *   robust than sniffing `tool_response` bodies for `"ok":false` substrings.
 *   The hook records the failed `tool_use_id`; PostToolBatch consults the
 *   set when deciding whether to terminate.
 *
 * - **Why `is_interrupt: true` is ignored**: an interrupted tool isn't a
 *   delivery failure — it's the user (or the harness) cancelling the call
 *   mid-flight. Treating that as "preserve the loop" would leak interrupted
 *   sessions into zombie state.
 *
 * What this preserves:
 *
 * - Happy path: terminator succeeds → loop terminates → no phantom-typing
 *   round-trip (the ~2-3s perf win from PR #122).
 * - Failure path: terminator's execute() threw → loop stays alive → model
 *   sees the error in the next assistant turn and can retry / message the
 *   user. The bug fixed: prior to this hook pair, a failed terminator
 *   terminated the loop silently and the user saw nothing (canonical
 *   incident: 2026-05-13 13:11Z 4096-char overflow).
 */
function buildTurnTerminatorHooks(): {
  postToolUseFailureHook: HookCallback;
  postToolBatchHook: HookCallback;
} {
  const failedTerminatorIds = new Set<string>();

  const postToolUseFailureHook: HookCallback = async (
    input,
  ): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PostToolUseFailure") {
      return { continue: true };
    }
    const failure = input as PostToolUseFailureHookInput;
    // Interrupts are not delivery failures — don't treat them as recoverable.
    if (failure.is_interrupt) return { continue: true };

    // Pass tool_input so soft-terminator react (`end_turn: false`) doesn't
    // get tracked here. If the call wasn't acting as a terminator, the
    // PostToolBatch path would have continued the loop anyway.
    if (!isTurnTerminator(failure.tool_name, failure.tool_input)) {
      return { continue: true };
    }

    failedTerminatorIds.add(failure.tool_use_id);
    log(
      "agent",
      `PostToolUseFailure: ${failure.tool_name} (${failure.tool_use_id}) ` +
        `failed — flagging for loop preservation. error: ${failure.error}`,
    );
    return { continue: true };
  };

  const postToolBatchHook: HookCallback = async (
    input,
  ): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PostToolBatch") {
      return { continue: true };
    }
    const batch = input as PostToolBatchHookInput;
    const terminator = batch.tool_calls.find((tc) =>
      isTurnTerminator(tc.tool_name, tc.tool_input),
    );
    if (!terminator) {
      return { continue: true };
    }

    // If the terminator failed, the failure hook flagged its tool_use_id.
    // Preserve the loop so the model can react to the error.
    if (failedTerminatorIds.has(terminator.tool_use_id)) {
      failedTerminatorIds.delete(terminator.tool_use_id);
      log(
        "agent",
        `PostToolBatch: ${terminator.tool_name} failed — keeping SDK loop ` +
          `alive so the model can read the error and retry`,
      );
      return { continue: true };
    }

    log(
      "agent",
      `PostToolBatch: terminating SDK loop on ${terminator.tool_name} ` +
        `(batch size: ${batch.tool_calls.length})`,
    );
    return {
      continue: false,
      stopReason: "turn terminated by end_turn / send",
    };
  };

  return { postToolUseFailureHook, postToolBatchHook };
}

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

/**
 * Build the SDK `systemPrompt` option from a prepared prompt.
 *
 * When a dynamic part exists, the prompt is sent as blocks split by
 * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`: everything before the marker is the
 * static prefix the API can cache across sessions; everything after is
 * the volatile tail (workspace listing, daily-memory pointer) that
 * changes between rebuilds without invalidating the prefix.
 */
function toSdkSystemPrompt(prepared: PreparedSystemPrompt): string | string[] {
  if (!prepared.dynamicText) return prepared.staticText;
  return [
    prepared.staticText,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    prepared.dynamicText,
  ];
}

export function buildSdkOptions(
  chatId: string,
  abortController?: AbortController,
  modelOverride?: string,
  preparedPrompt?: PreparedSystemPrompt,
): BuildSdkOptionsResult {
  const config = getConfig();
  const chatSettings = getChatSettings(chatId);
  const activeModel = modelOverride ?? chatSettings.model ?? config.model;
  const activeEffort = chatSettings.effort ?? "adaptive";
  const resolvedActiveModel = resolveModelId(activeModel);

  const thinkingConfig = EFFORT_MAP[activeEffort] ?? {
    thinking: { type: "adaptive" as const },
  };

  const session = getSession(chatId);

  // Per-session closure-shared state for the terminator hook pair (see
  // buildTurnTerminatorHooks docstring). Each chat gets its own failure set
  // so concurrent sessions never leak flags into each other.
  const { postToolUseFailureHook, postToolBatchHook } =
    buildTurnTerminatorHooks();

  const options: Options = {
    model: resolvedActiveModel,
    // Prefer the caller's frozen per-session prompt; fall back to the
    // global config split (warm-up and legacy callers), then to the
    // plain string for configs built without parts (tests).
    systemPrompt: preparedPrompt
      ? toSdkSystemPrompt(preparedPrompt)
      : config.systemPromptParts
        ? toSdkSystemPrompt({
            text: config.systemPrompt,
            staticText: config.systemPromptParts.staticText,
            dynamicText: config.systemPromptParts.dynamicText,
          })
        : config.systemPrompt,
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
    // Cancellation signal — when aborted, the SDK tears down the spawned
    // subprocess and stops streaming. The chat handler uses this both as a
    // shutdown hook for the daemon and as the kill-switch for a watchdog
    // that fires if the SDK iterator hangs after emitting `result`. The
    // happy-path SDK exit is owned by the PostToolBatch hook below; this
    // is defence in depth, not the primary terminator.
    ...(abortController ? { abortController } : {}),
    ...(config.claudeBinary
      ? { pathToClaudeCodeExecutable: config.claudeBinary }
      : {}),
    // Whitelist of SDK built-in tools. Anything not listed (e.g. WebSearch,
    // WebFetch, Monitor, PushNotification, RemoteTrigger, Plan/Worktree/Todo
    // helpers, AskUserQuestion, ScheduleWakeup) is unavailable to the model.
    // MCP tools are governed independently via `mcpServers` below.
    tools: [...ALLOWED_TOOLS_CHAT],
    ...thinkingConfig,
    mcpServers: {
      ...buildMcpServers(chatId),
      ...getPluginMcpServers(`http://127.0.0.1:${getBridgePort()}`, chatId),
    },
    hooks: {
      PostToolUseFailure: [{ hooks: [postToolUseFailureHook] }],
      PostToolBatch: [{ hooks: [postToolBatchHook] }],
      Notification: [{ hooks: [notificationHook] }],
      StopFailure: [{ hooks: [stopFailureHook] }],
    },
    ...(session.sessionId ? { resume: session.sessionId } : {}),
  };

  return { options, activeModel, session };
}
