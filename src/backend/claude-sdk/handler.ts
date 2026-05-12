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
import { isTurnTerminator, stripMcpPrefix } from "../../core/tools/index.js";

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
  normalizeForDedupe,
  isDuplicateOfDelivered,
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

  // Capture text args from delivery tools (`end_turn`, `send(type="text")`)
  // so the end-of-turn trailing-text fallback can dedupe against content
  // already delivered. Without this, a model that writes prose AND calls a
  // delivery tool with similar text would surface twice in the chat.
  //
  // Tool names arrive MCP-prefixed (e.g. `mcp__telegram-tools__end_turn`)
  // when routed through MCP — strip the prefix so equality checks match
  // the registry's bare names.
  const captureDeliveredText = (
    toolName: string,
    input: Record<string, unknown>,
  ): void => {
    const bareName = stripMcpPrefix(toolName);
    let deliveredText: string | undefined;
    if (bareName === "end_turn" && typeof input.text === "string") {
      deliveredText = input.text;
    } else if (
      bareName === "send" &&
      input.type === "text" &&
      typeof input.text === "string"
    ) {
      deliveredText = input.text;
    }
    if (deliveredText) {
      const norm = normalizeForDedupe(deliveredText);
      if (norm) state.deliveredTextNorms.push(norm);
    }
  };

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

        // Track the trailing text from this assistant message. Multiple
        // assistant messages can fire per turn (one per tool-use round-trip);
        // only the LAST one's trailingText is the user-facing final reply.
        state.lastTrailingText = result.trailingText;

        // Notify tool usage + capture delivery-tool text for end-of-turn dedup
        for (const tool of result.tools) {
          incrementCounter(`tool_calls.${tool.name}`);
          captureDeliveredText(tool.name, tool.input);
          // Pass tool.input so the soft-terminator opt-out (e.g. react
          // with `end_turn: false`) keeps state.turnTerminated correctly
          // false — otherwise the trailing-text dedup path mis-treats a
          // mid-turn react as the final delivery.
          if (isTurnTerminator(tool.name, tool.input)) {
            state.turnTerminated = true;
          }
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

        // Note: we previously called `qi.interrupt()` here when a turn-
        // terminator tool fired, intending to short-circuit the SDK's
        // wasted "wrap up after end_turn tool_result" follow-up API call
        // (~3s of phantom typing while the model says nothing useful).
        // That interrupt races with in-flight MCP tool dispatches in the
        // same assistant message — `end_turn` itself is an MCP tool, and
        // the model frequently emits sibling tool_use blocks in the same
        // message. interrupt cancels their AbortController mid-flight,
        // which surfaces as `MCP error -32001: AbortError` in the SDK
        // result and bubbles up to the user as "Something went wrong".
        //
        // The natural-close path is fine: the SDK does one more API call
        // after end_turn returns (the model has nothing to say so it
        // returns a stop turn quickly, ~2-3s typing lag), then yields a
        // result message and exits the iterator cleanly. We accept the
        // typing lag in exchange for not breaking turns. `state.turnTerminated`
        // is still tracked so the flow-violation re-prompt path below can
        // skip its retry when the model explicitly ended its turn.
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
    if (activeQueries.get(chatId) === qi) {
      activeQueries.delete(chatId);
    }
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

  // ── Trailing-prose contract + flow-violation retry ──────────────────────
  // The output stream is private scratchpad by design. Final replies must go
  // through `end_turn` (canonical) or `send` (mid-turn rich content). When a
  // turn ends with no tool call AND no trailing prose, that's valid silent
  // close (model only reacted, or had nothing to do). When the model wrote
  // prose but didn't route it through a delivery tool, that's a flow
  // violation — the prose is private scratchpad, dropped from the user's
  // view. To prevent these from going unnoticed, we re-prompt the model
  // ONCE with a synthetic system message in the same session: it sees its
  // broken turn in history + a reminder of the contract, and gets a fresh
  // turn to deliver via end_turn. If it violates again on the retry, we
  // give up loudly and accept the silent drop.
  //
  // Exception: if a turn-terminator tool (e.g. end_turn) was called, the
  // model explicitly declared "I'm done" — respect it. Any trailing prose
  // that slipped in earlier in the same assistant message gets logged but
  // does NOT re-prompt (would loop endlessly with a model that pairs prose
  // with end_turn).
  const trailing = state.lastTrailingText.trim();
  const flowViolation =
    trailing.length > 0 &&
    !state.turnTerminated &&
    !isDuplicateOfDelivered(trailing, state.deliveredTextNorms);

  if (flowViolation) {
    incrementCounter("scratchpad.trailing_text_dropped");
    log(
      "agent",
      `[${chatId}] flow violation: trailing prose (${trailing.length} chars) without end_turn/send. ${
        _retried
          ? "Already retried — accepting silent drop."
          : "Re-prompting with reminder."
      }`,
    );

    if (!_retried) {
      incrementCounter("scratchpad.flow_violation_retried");
      const reminder =
        "[FLOW VIOLATION] You produced text content but didn't call `end_turn` or `send`. " +
        "Pure prose in your output stream is private scratchpad — it's dropped, the user " +
        "never sees it. Please retry with the proper flow: " +
        "`end_turn(text=...)` to deliver a final reply, " +
        "`end_turn()` (no args) to close silently, or " +
        "`send(...)` for mid-turn rich content (photos, polls, etc.). " +
        "Respond now using the correct tool call.";
      return handleMessage({ ...params, text: reminder }, true);
    }
  }

  // ── Build result ──────────────────────────────────────────────────────────

  state.allResponseText += state.currentBlockText;
  const cacheTotal = state.sdkInputTokens + state.sdkCacheRead;
  const cacheHitPct =
    cacheTotal > 0 ? Math.round((state.sdkCacheRead / cacheTotal) * 100) : 0;

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
