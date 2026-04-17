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
import { incrementCounter, recordHistogram } from "../../util/metrics.js";
import { formatFullDatetime } from "../../util/time.js";

import type { Query } from "@anthropic-ai/claude-agent-sdk";
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

// ── Active query store ──────────────────────────────────────────────────────
// Holds the Query reference for each in-flight chat so gateway actions
// (e.g. reload_plugins) can call control methods like setMcpServers().

const activeQueries = new Map<string, Query>();

/** Get the active Query for a chat, if one is in flight. */
export function getActiveQuery(chatId: string): Query | undefined {
  return activeQueries.get(chatId);
}

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
  activeQueries.set(chatId, qi);
  const state = createStreamState();

  // ── Progress watchdog ──────────────────────────────────────────────────
  // A query is "making progress" whenever the SDK emits any message. If
  // silence stretches beyond WATCHDOG_MS, something downstream is hung
  // (MCP subprocess died, network stall, model API wedge, etc.) — we
  // interrupt the query so the for-await throws and the caller sees an
  // actual error instead of typing forever.
  const WATCHDOG_MS = 5 * 60 * 1000; // 5 minutes of total silence
  const WATCHDOG_CHECK_MS = 30_000; // check every 30s
  let lastActivityAt = Date.now();
  let watchdogFired = false;
  const bumpActivity = (): void => {
    lastActivityAt = Date.now();
  };
  const watchdogTimer = setInterval(() => {
    const silent = Date.now() - lastActivityAt;
    if (silent > WATCHDOG_MS && !watchdogFired) {
      watchdogFired = true;
      logWarn(
        "agent",
        `[${chatId}] Watchdog: no SDK activity for ${Math.round(silent / 1000)}s — interrupting query`,
      );
      incrementCounter("agent.watchdog_fired");
      qi.interrupt().catch((err: unknown) => {
        logWarn(
          "agent",
          `[${chatId}] Watchdog interrupt() failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }, WATCHDOG_CHECK_MS);

  try {
    for await (const message of qi) {
      bumpActivity();
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
          incrementCounter(`tool_calls.${tool.name}`);
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
        processResultMessage(message, state, options.model ?? activeModel);
      }
    }
  } catch (err) {
    const classified = classify(err);
    incrementCounter(`errors.${classified.reason ?? "unknown"}`);

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

    // Model fallback: if overloaded/timeout, retry with the configured fallback
    if (!_retried && classified.retryable) {
      const fallback = getFallbackModel(activeModel);
      if (fallback) {
        logWarn(
          "agent",
          `[${chatId}] ${classified.reason}, falling back to ${fallback}`,
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
  } finally {
    clearInterval(watchdogTimer);
    if (activeQueries.get(chatId) === qi) {
      activeQueries.delete(chatId);
    }
  }

  // If the watchdog fired, the for-await exited without a result — surface
  // this as an explicit error so the caller (dispatcher / frontend) sends a
  // proper reply rather than pretending the turn succeeded silently.
  if (watchdogFired && !state.newSessionId && !state.allResponseText) {
    incrementCounter("errors.watchdog_timeout");
    const err = new Error(
      `Query timed out after ${WATCHDOG_MS / 1000}s of SDK silence (likely a stuck tool call)`,
    );
    logError("agent", `[${chatId}] ${err.message}`);
    throw err;
  }

  // ── Persist session and usage ─────────────────────────────────────────────

  const durationMs = Date.now() - t0;
  recordHistogram("response_latency_ms", durationMs);
  incrementCounter("queries_total");
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
