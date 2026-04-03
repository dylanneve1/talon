import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TalonConfig } from "../../util/config.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  resetSession,
  setSessionId,
  setSessionName,
} from "../../storage/sessions.js";
import { getChatSettings, setChatModel } from "../../storage/chat-settings.js";
import { getRecentHistory } from "../../storage/history.js";
import { resolve } from "node:path";
import { classify } from "../../core/errors.js";
import {
  getPluginMcpServers,
  getPluginPromptAdditions,
} from "../../core/plugin.js";
import { rebuildSystemPrompt } from "../../util/config.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { formatSmartTimestamp, formatFullDatetime } from "../../util/time.js";
import { recordResponse } from "../../storage/self-monitor.js";

import type { QueryParams, QueryResult } from "../../core/types.js";

// ── State ────────────────────────────────────────────────────────────────────

let config: TalonConfig;
let bridgePortFn: () => number = () => 19876;

export function initAgent(
  cfg: TalonConfig,
  getBridgePort?: () => number,
): void {
  config = cfg;
  if (getBridgePort) bridgePortFn = getBridgePort;

  // The Agent SDK spawns an embedded Claude Code subprocess.
  // If CLAUDECODE is set (e.g. running from a Claude Code terminal),
  // the subprocess refuses to start with a nested-session error that
  // gets swallowed — causing an infinite hang on Windows.
  delete process.env.CLAUDECODE;
}

// ── Constants ────────────────────────────────────────────────────────────────

const EFFORT_MAP: Record<
  string,
  { thinking: { type: "adaptive" | "disabled" }; effort?: "low" | "medium" | "high" | "max" }
> = {
  off: { thinking: { type: "disabled" } },
  low: { thinking: { type: "adaptive" }, effort: "low" },
  medium: { thinking: { type: "adaptive" }, effort: "medium" },
  high: { thinking: { type: "adaptive" }, effort: "high" },
  max: { thinking: { type: "adaptive" }, effort: "max" },
};

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  if (!config)
    throw new Error("Agent not initialized. Call initAgent() first.");

  const {
    chatId,
    text,
    senderName,
    isGroup,
    onTextBlock,
    onStreamDelta,
    onToolUse,
  } = params;
  const session = getSession(chatId);
  const t0 = Date.now();

  // Rebuild system prompt on first turn of a new/reset session so identity,
  // memory, and workspace listing are fresh
  if (session.turns === 0) {
    rebuildSystemPrompt(config, getPluginPromptAdditions());
  }

  // Per-chat settings override global config
  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.model;
  const activeEffort = chatSettings.effort ?? "adaptive";

  const thinkingConfig = EFFORT_MAP[activeEffort] ?? {
    thinking: { type: "adaptive" as const },
  };

  const options = {
    model: activeModel,
    systemPrompt: config.systemPrompt,
    cwd: config.workspace,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    betas: ["context-1m-2025-08-07"],
    ...(config.claudeBinary
      ? { pathToClaudeCodeExecutable: config.claudeBinary }
      : {}),
    disallowedTools: [
      "EnterPlanMode",
      "ExitPlanMode",
      "EnterWorktree",
      "ExitWorktree",
      "TodoWrite",
      "TodoRead",
      "TaskCreate",
      "TaskUpdate",
      "TaskGet",
      "TaskList",
      "TaskOutput",
      "TaskStop",
      "AskUserQuestion",
    ],
    ...thinkingConfig,
    mcpServers: {
      // Register frontend-specific MCP tools based on active frontend
      ...(() => {
        const frontends = Array.isArray(config.frontend)
          ? config.frontend
          : [config.frontend];
        const bridgeUrl = `http://127.0.0.1:${bridgePortFn()}`;
        const mcpEnv = { TALON_BRIDGE_URL: bridgeUrl, TALON_CHAT_ID: chatId };
        const servers: Record<
          string,
          { command: string; args: string[]; env: Record<string, string> }
        > = {};
        // Resolve tsx from Talon's node_modules (cwd may be ~/.talon/workspace/ which has no node_modules)
        // Resolve tsx from the package root (3 levels up from src/backend/claude-sdk/)
        const tsxImport = resolve(
          import.meta.dirname ?? ".",
          "../../../node_modules/tsx/dist/esm/index.mjs",
        );

        if (frontends.includes("telegram")) {
          // Determine frontend mode for tool filtering
          const frontendMode = config.apiId && config.apiHash
            ? (config.botToken ? "dual" : "userbot")
            : "bot";

          servers["telegram-tools"] = {
            command: process.platform === "win32" ? "npx" : "node",
            args:
              process.platform === "win32"
                ? ["tsx", resolve(import.meta.dirname ?? ".", "tools/index.ts")]
                : [
                    "--import",
                    tsxImport,
                    resolve(import.meta.dirname ?? ".", "tools/index.ts"),
                  ],
            env: { ...mcpEnv, TALON_FRONTEND_MODE: frontendMode },
          };
        }
        if (frontends.includes("teams")) {
          servers["teams-tools"] = {
            command: process.platform === "win32" ? "npx" : "node",
            args:
              process.platform === "win32"
                ? [
                    "tsx",
                    resolve(
                      import.meta.dirname ?? ".",
                      "../../frontend/teams/tools.ts",
                    ),
                  ]
                : [
                    "--import",
                    tsxImport,
                    resolve(
                      import.meta.dirname ?? ".",
                      "../../frontend/teams/tools.ts",
                    ),
                  ],
            env: mcpEnv,
          };
        }
        return servers;
      })(),
      ...getPluginMcpServers(`http://127.0.0.1:${bridgePortFn()}`, chatId),
    },
    ...(session.sessionId ? { resume: session.sessionId } : {}),
  };

  const msgIdHint = params.messageId ? ` [msg_id:${params.messageId}]` : "";
  const nowTag = `[${formatFullDatetime()}]`;

  // Session continuity: when resuming a session that has history but no active
  // SDK session (after restart or /resume), prepend recent messages for context.
  let continuityPrefix = "";
  if (!session.sessionId && session.turns > 0) {
    const recentMsgs = getRecentHistory(chatId, 10);
    if (recentMsgs.length > 0) {
      const contextLines = recentMsgs
        .map((m) => {
          const time = formatSmartTimestamp(m.timestamp);
          return `[${time}] ${m.senderName}: ${m.text.slice(0, 300)}`;
        })
        .join("\n");
      continuityPrefix = `[Session resumed — recent conversation context:\n${contextLines}]\n\n`;
    }
  }

  const prompt = isGroup
    ? `${continuityPrefix}${nowTag} [${senderName}]${msgIdHint}: ${text}`
    : `${continuityPrefix}${nowTag}${msgIdHint} ${text}`;
  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  // SDK types are not fully exported; cast options at the boundary
  const qi = query({
    prompt,
    options: options as Parameters<typeof query>[0]["options"],
  });

  let currentBlockText = "";
  let allResponseText = "";
  let newSessionId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let toolCalls = 0;

  // Streaming throttle
  let lastStreamUpdate = 0;
  const STREAM_INTERVAL = 300;

  try {
    for await (const message of qi) {
      const msg = message as Record<string, unknown>;
      const type = msg.type as string;

      // Session ID capture
      if (
        type === "system" &&
        msg.subtype === "init" &&
        typeof msg.session_id === "string"
      ) {
        newSessionId = msg.session_id;
      }

      // Stream text deltas and thinking deltas
      if (type === "stream_event" && onStreamDelta) {
        const event = msg.event as Record<string, unknown> | undefined;
        if (event?.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (
            delta?.type === "thinking_delta" &&
            typeof delta.thinking === "string"
          ) {
            // Thinking phase: notify but don't accumulate text
            const now = Date.now();
            if (now - lastStreamUpdate >= STREAM_INTERVAL) {
              lastStreamUpdate = now;
              onStreamDelta(currentBlockText, "thinking");
            }
          } else if (
            delta?.type === "text_delta" &&
            typeof delta.text === "string"
          ) {
            currentBlockText += delta.text;
            const now = Date.now();
            if (now - lastStreamUpdate >= STREAM_INTERVAL) {
              lastStreamUpdate = now;
              onStreamDelta(currentBlockText, "text");
            }
          }
        }
      }

      // Complete assistant message — may contain multiple text blocks
      // and tool_use blocks. Each text block before a tool_use is a
      // "progress message" that should be sent immediately.
      if (type === "assistant") {
        const content = (msg.message as { content?: unknown[] })?.content;
        if (Array.isArray(content)) {
          let blockText = "";
          for (const block of content) {
            const b = block as { type: string; text?: string; name?: string };
            if (b.type === "text" && b.text) {
              blockText += b.text;
            }
            if (b.type === "tool_use") {
              toolCalls++;
              const tb = block as {
                type: string;
                name?: string;
                input?: Record<string, unknown>;
              };
              if (onToolUse && tb.name) {
                try {
                  onToolUse(tb.name, tb.input ?? {});
                } catch {
                  /* non-fatal */
                }
              }
              // If there's text before this tool call, send it as a progress message
              if (blockText.trim() && onTextBlock) {
                try {
                  await onTextBlock(blockText.trim());
                } catch {
                  /* non-fatal — don't abort the stream loop */
                }
                allResponseText += blockText;
                blockText = "";
                currentBlockText = "";
              }
            }
          }
          // Remaining text after all tool calls (or if no tool calls)
          if (blockText.trim()) {
            currentBlockText = blockText;
          }
        }
      }

      // Final result
      if (type === "result") {
        const usage = msg.usage as Record<string, number> | undefined;
        if (usage) {
          inputTokens = usage.input_tokens ?? 0;
          outputTokens = usage.output_tokens ?? 0;
          cacheRead = usage.cache_read_input_tokens ?? 0;
          cacheWrite = usage.cache_creation_input_tokens ?? 0;
        }
        // If we still have unsent text and no streaming captured it
        if (
          !allResponseText &&
          !currentBlockText &&
          typeof msg.result === "string"
        ) {
          currentBlockText = msg.result;
        }
      }
    }
  } catch (err) {
    const classified = classify(err);
    if (classified.reason === "session_expired" && !_retried) {
      logWarn(
        "agent",
        `[${chatId}] Stale session, retrying with fresh session`,
      );
      resetSession(chatId);
      return handleMessage(params, true);
    }
    // Context length exceeded — reset session and retry (SDK auto-compaction should prevent
    // this, but handle it as a safety net for edge cases)
    if (classified.reason === "context_length" && !_retried) {
      logWarn(
        "agent",
        `[${chatId}] Context length exceeded, resetting session and retrying`,
      );
      resetSession(chatId);
      return handleMessage(params, true);
    }
    // Model fallback: if overloaded/timeout, retry with a faster model
    if (!_retried && classified.retryable) {
      const fallbackModel = activeModel.includes("opus")
        ? "claude-sonnet-4-6"
        : activeModel.includes("sonnet")
          ? "claude-haiku-4-5"
          : null;
      if (fallbackModel) {
        logWarn(
          "agent",
          `[${chatId}] ${classified.reason}, falling back to ${fallbackModel.replace("claude-", "")}`,
        );
        resetSession(chatId);
        const originalModel = getChatSettings(chatId).model;
        setChatModel(chatId, fallbackModel);
        try {
          return await handleMessage(params, true);
        } finally {
          setChatModel(chatId, originalModel);
        }
      }
    }
    logError("agent", `[${chatId}] SDK error: ${classified.message}`);
    throw classified;
  }

  // Persist session and usage
  const durationMs = Date.now() - t0;
  if (newSessionId) setSessionId(chatId, newSessionId);
  incrementTurns(chatId);
  recordUsage(chatId, {
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    durationMs,
    model: activeModel,
  });

  // Set a descriptive session name from the first message
  if (session.turns === 0 && text) {
    // Strip metadata prefixes like [DM from ...] or [Name]:
    const cleanText = text
      .replace(/^\[.*?\]\s*/g, "")
      .replace(/\[msg_id:\d+\]\s*/g, "")
      .trim();
    if (cleanText) {
      const name =
        cleanText.length > 30 ? cleanText.slice(0, 30) + "..." : cleanText;
      setSessionName(chatId, name);
    }
  }

  // The remaining currentBlockText is the final response text
  allResponseText += currentBlockText;

  // Cache hit %: cacheRead / (cacheRead + inputTokens). cacheWrite is tokens
  // written TO cache for future use, not part of this request's prompt cost.
  const totalPrompt = inputTokens + cacheRead;
  const cacheHitPct =
    totalPrompt > 0 ? Math.round((cacheRead / totalPrompt) * 100) : 0;

  log(
    "agent",
    `[${chatId}] -> (${durationMs}ms, in=${inputTokens} out=${outputTokens} cache=${cacheHitPct}%` +
      `${toolCalls > 0 ? ` tools=${toolCalls}` : ""})`,
  );

  // Record metrics for self-monitoring
  try {
    recordResponse(inputTokens, outputTokens, durationMs, allResponseText.trim().length > 0, toolCalls);
  } catch { /* self-monitor not loaded */ }
  traceMessage(chatId, "out", allResponseText, {
    durationMs,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    toolCalls,
    model: activeModel,
  });

  return {
    text: allResponseText.trim(),
    durationMs,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
  };
}
