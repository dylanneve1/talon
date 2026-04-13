/**
 * Main message handler — executes a user query through the Claude Agent SDK.
 *
 * Orchestrates the full lifecycle: prompt formatting, SDK query, stream
 * processing, error recovery (session expired / context overflow / model
 * fallback), token accounting, and session persistence.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  getSession,
  incrementTurns,
  recordUsage,
  resetSession,
  setSessionId,
  setSessionName,
} from "../../storage/sessions.js";
import { getChatSettings, setChatModel } from "../../storage/chat-settings.js";
import { classify } from "../../core/errors.js";
import { getFallbackModel } from "../../core/models.js";
import { rebuildSystemPrompt } from "../../util/config.js";
import { getPluginPromptAdditions } from "../../core/plugin.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { formatFullDatetime } from "../../util/time.js";

import type { QueryParams, QueryResult } from "../../core/types.js";
import { getConfig } from "./state.js";
import { buildSdkOptions } from "./options.js";
import {
  createStreamState,
  isSystemInit,
  isStreamEvent,
  isAssistant,
  isResult,
  processStreamDelta,
  processAssistantMessage,
  processResultMessage,
} from "./stream.js";

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  const config = getConfig();

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

  const { options, activeModel } = buildSdkOptions(chatId);

  const msgIdHint = params.messageId ? ` [msg_id:${params.messageId}]` : "";
  const nowTag = `[${formatFullDatetime()}]`;

  const prompt = isGroup
    ? `${nowTag} [${senderName}]${msgIdHint}: ${text}`
    : `${nowTag}${msgIdHint} ${text}`;
  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  const qi = query({ prompt, options });
  const state = createStreamState();

  try {
    for await (const message of qi) {
      // Session ID capture
      if (isSystemInit(message)) {
        state.newSessionId = message.session_id;
        continue;
      }

      // Stream text deltas and thinking deltas
      if (isStreamEvent(message)) {
        processStreamDelta(message, state, onStreamDelta);
        continue;
      }

      // Complete assistant message — extract text blocks and tool calls
      if (isAssistant(message)) {
        const result = processAssistantMessage(message, state);

        // Notify tool usage
        for (const tool of result.tools) {
          if (onToolUse) {
            try {
              onToolUse(tool.name, tool.input);
            } catch {
              /* non-fatal */
            }
          }
        }

        // Send progress text segments (text before each tool call) in order
        if (onTextBlock) {
          for (const text of result.progressTexts) {
            try {
              await onTextBlock(text);
            } catch {
              /* non-fatal — don't abort the stream loop */
            }
          }
        }
        continue;
      }

      // Final result — read token counts and context info
      if (isResult(message)) {
        processResultMessage(message, state, activeModel);
      }
    }
  } catch (err) {
    const classified = classify(err);

    // Session expired — reset and retry once
    if (classified.reason === "session_expired" && !_retried) {
      logWarn(
        "agent",
        `[${chatId}] Stale session, retrying with fresh session`,
      );
      resetSession(chatId);
      return handleMessage(params, true);
    }

    // Context length exceeded — safety net for edge cases where SDK
    // auto-compaction doesn't prevent overflow
    if (classified.reason === "context_length" && !_retried) {
      logWarn(
        "agent",
        `[${chatId}] Context length exceeded, resetting session and retrying`,
      );
      resetSession(chatId);
      return handleMessage(params, true);
    }

    // Model fallback: if overloaded/timeout, retry with the next-tier model
    if (!_retried && classified.retryable) {
      const fallback = getFallbackModel(activeModel);
      if (fallback) {
        logWarn(
          "agent",
          `[${chatId}] ${classified.reason}, falling back to ${fallback.replace("claude-", "")}`,
        );
        resetSession(chatId);
        const originalModel = getChatSettings(chatId).model;
        setChatModel(chatId, fallback);
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

  // ── Persist session and usage ─────────────────────────────────────────────

  const durationMs = Date.now() - t0;
  if (state.newSessionId) setSessionId(chatId, state.newSessionId);
  incrementTurns(chatId);
  recordUsage(chatId, {
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
    durationMs,
    model: activeModel,
    contextTokens: state.contextTokens,
    contextWindow: state.contextWindow,
    numApiCalls: state.numApiCalls,
  });

  // Set a descriptive session name from the first message
  if (session.turns === 0 && text) {
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

  // ── Build result ──────────────────────────────────────────────────────────

  state.allResponseText += state.currentBlockText;
  const totalPrompt =
    state.sdkInputTokens + state.sdkCacheRead + state.sdkCacheWrite;
  const cacheHitPct =
    totalPrompt > 0 ? Math.round((state.sdkCacheRead / totalPrompt) * 100) : 0;

  log(
    "agent",
    `[${chatId}] -> (${durationMs}ms, in=${state.sdkInputTokens} out=${state.sdkOutputTokens} cache=${cacheHitPct}%` +
      `${state.toolCalls > 0 ? ` tools=${state.toolCalls}` : ""})`,
  );
  traceMessage(chatId, "out", state.allResponseText, {
    durationMs,
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
    toolCalls: state.toolCalls,
    model: activeModel,
  });

  return {
    text: state.allResponseText.trim(),
    durationMs,
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
  };
}
