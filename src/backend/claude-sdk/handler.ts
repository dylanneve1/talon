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
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { incrementCounter, recordHistogram } from "../../util/metrics.js";
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
} from "./stream.js";
import {
  formatUserPrompt,
  prepareSystemPrompt,
  extractSessionName,
  isDuplicateOfDelivered,
  captureDeliveredText,
  classifyRetry,
  summarizeUsage,
} from "../shared/index.js";

// ── Active query store ──────────────────────────────────────────────────────
// Holds the Query reference for each in-flight chat so gateway actions
// (e.g. reload_plugins) can call control methods like setMcpServers().

const activeQueries = new Map<string, Query>();

/** Get the active Query for a chat, if one is in flight. */
export function getActiveQuery(chatId: string): Query | undefined {
  return activeQueries.get(chatId);
}

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * Maximum number of synthetic [FLOW VIOLATION] re-prompts before we give up
 * and accept a silent drop. Set high enough that a well-behaved model with
 * a one-off slip-up always recovers; low enough that a pathologically broken
 * model doesn't loop indefinitely burning tokens. After this cap, the drop
 * is still logged at ERROR level so it's visible in observability.
 */
const FLOW_VIOLATION_MAX_RETRIES = 3;

export async function handleMessage(
  params: QueryParams,
  /** Internal: number of [FLOW VIOLATION] re-prompts already attempted. */
  _retryCount: number = 0,
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
  // memory, and workspace listing are fresh. `prepareSystemPrompt` does
  // this in place (mutates config.systemPrompt) — the Claude SDK reads
  // from config.systemPrompt later via `buildSdkOptions`, so the rebuild
  // has to land before that call.
  prepareSystemPrompt({ config, previousTurns: session.turns });

  const { options, activeModel } = buildSdkOptions(chatId);

  const prompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId: params.messageId,
  });
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
  // `captureDeliveredText` (from shared/) returns the normalized text
  // norm — push it into state for the post-turn dedup check.
  const captureIntoState = (
    toolName: string,
    input: Record<string, unknown>,
  ): void => {
    const norm = captureDeliveredText(toolName, input);
    if (norm) state.deliveredTextNorms.push(norm);
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
          incrementCounter(`tool_calls.${stripMcpPrefix(tool.name)}`);
          captureIntoState(tool.name, tool.input);
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

        // Turn-terminator detection happens here (sets `state.turnTerminated`
        // for the flow-violation check below) but the actual SDK loop exit
        // is owned by the `PostToolBatch` hook in `options.ts`. The hook
        // fires after every tool in the batch has resolved, returns
        // `{ continue: false }`, and the SDK exits with TerminalReason
        // `'hook_stopped'` — no extra "wrap up after end_turn" round-trip,
        // no phantom typing, no token spend on a stop_turn.
        //
        // Historical note: an earlier implementation called `qi.interrupt()`
        // here directly. That raced with in-flight MCP tool dispatches in
        // the same assistant message — `end_turn` itself is an MCP tool,
        // and the model frequently emits sibling tool_use blocks alongside
        // it. `interrupt()` cancelled their AbortController mid-flight,
        // surfacing as `MCP error -32001: AbortError` and bubbling up as
        // "Something went wrong". The `PostToolBatch` hook avoids the race
        // by definition (it fires once the entire batch has resolved).
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

    const decision = classifyRetry({
      error: classified,
      activeModel,
      retried: _retryCount > 0,
    });

    if (decision.kind === "reset_and_retry") {
      logWarn(
        "agent",
        `[${chatId}] ${decision.reason}, resetting session and retrying`,
      );
      resetSession(chatId);
      return handleMessage(params, _retryCount + 1);
    }

    if (decision.kind === "fallback_model") {
      logWarn(
        "agent",
        `[${chatId}] ${classified.reason}, falling back to ${decision.fallbackModelId}`,
      );
      resetSession(chatId);
      const originalModel = getChatSettings(chatId).model;
      setChatModel(chatId, decision.fallbackModelId);
      try {
        return await handleMessage(params, _retryCount + 1);
      } finally {
        setChatModel(chatId, originalModel);
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
  // Token usage is recorded for THIS attempt unconditionally — the running
  // session totals are additive, so a flow-violation retry that recurses
  // through this same path will record its own tokens on top. The turn
  // counter, in contrast, must only increment ONCE per user message (see
  // the post-violation block below).
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
    const name = extractSessionName(text);
    if (name) setSessionName(chatId, name);
  }

  // ── Flow-violation contract + retry ─────────────────────────────────────
  // The output stream is private scratchpad by design. Every turn must end
  // by calling one of: `end_turn` (canonical reply terminator),
  // `send` (mid-turn rich content that also terminates), or `react`
  // (turn-terminating reaction). `end_turn()` with no args is the explicit
  // "I chose not to reply" close — valid and the ONLY way to legitimately
  // end a turn without delivering.
  //
  // If the SDK loop ends without `state.turnTerminated` being set, the
  // model failed to commit:
  //   - It may have written prose to its scratchpad without routing it
  //     through a delivery tool (classic flow violation).
  //   - It may have done tool calls but no terminator (e.g., ran Bash
  //     then exited without `end_turn` — the user sees nothing).
  //   - It may have done nothing at all (extremely unusual; usually
  //     means an upstream error).
  //
  // ALL of these are flow violations. The system MUST re-prompt the model
  // with a synthetic `[FLOW VIOLATION]` reminder so it can correct, up to
  // FLOW_VIOLATION_MAX_RETRIES times. Silent drop without retry would
  // mean the user gets no response and no observability — exactly the
  // failure mode we're guarding against. After the cap is exhausted (a
  // pathological model can't recover after 3 reminders), we log at
  // ERROR level and accept the drop only as a last resort.
  //
  // Exception: if `state.turnTerminated` is true, the model explicitly
  // closed the turn — respect it even if trailing prose slipped in
  // earlier in the same assistant message (would loop endlessly with a
  // model that habitually pairs prose with end_turn).
  //
  // `incrementTurns` is deferred until AFTER this check so the retry path
  // (which recurses through `handleMessage` and hits its own
  // `incrementTurns` at the end of that call) doesn't double-count a
  // single user message as two turns.
  const trailing = state.lastTrailingText.trim();
  const hadActivity = trailing.length > 0 || state.toolCalls > 0;
  const isTrailingDuplicate =
    trailing.length > 0 &&
    isDuplicateOfDelivered(trailing, state.deliveredTextNorms);

  // No flow violation: either the model explicitly terminated, or there
  // was literally nothing to deliver (no prose, no tool calls — rare),
  // or the trailing prose was a duplicate of what end_turn already
  // delivered (model wrote text + called end_turn with the same text).
  const flowViolation =
    !state.turnTerminated && hadActivity && !isTrailingDuplicate;

  if (flowViolation) {
    const violationKind =
      trailing.length > 0
        ? `trailing prose (${trailing.length} chars)`
        : `${state.toolCalls} tool call${state.toolCalls === 1 ? "" : "s"} with no terminator`;

    if (_retryCount < FLOW_VIOLATION_MAX_RETRIES) {
      incrementCounter("scratchpad.flow_violation_retried");
      log(
        "agent",
        `[${chatId}] flow violation (retry ${_retryCount + 1}/${FLOW_VIOLATION_MAX_RETRIES}): ${violationKind} without end_turn/send. Re-prompting with reminder.`,
      );
      const reminder =
        "[FLOW VIOLATION] Your previous turn ended without calling a delivery " +
        "tool (`end_turn`, `send`, or `react`). Pure prose in your output " +
        "stream is private scratchpad — the user never sees it. Tool calls " +
        "alone do not close the turn. You MUST call one of these to commit:\n" +
        "  • `end_turn(text=...)` — deliver a final reply\n" +
        '  • `end_turn()` — close silently (explicit "no reply")\n' +
        "  • `send(...)` — mid-turn rich content (photos, polls, etc.)\n" +
        "  • `react(emoji=...)` — react and close\n" +
        "Respond now with the correct tool call. If you intended to send no " +
        "reply, call `end_turn()` with no arguments to commit that choice.";
      return handleMessage({ ...params, text: reminder }, _retryCount + 1);
    }

    // Cap exhausted — log at ERROR level so observability catches it.
    // We accept the drop here only because we've exhausted retries; a
    // model that can't commit after 3 reminders has a deeper problem
    // worth investigating, not a transient slip-up.
    incrementCounter("scratchpad.flow_violation_cap_exhausted");
    logError(
      "agent",
      `[${chatId}] flow violation cap exhausted after ${FLOW_VIOLATION_MAX_RETRIES} retries: ${violationKind} without end_turn/send. Accepting silent drop — model may be malfunctioning.`,
    );
    incrementCounter("scratchpad.trailing_text_dropped");
  }

  // Reached the non-retry path — this turn counts as one user-visible turn.
  incrementTurns(chatId);

  // ── Build result ──────────────────────────────────────────────────────────

  state.allResponseText += state.currentBlockText;

  log(
    "agent",
    `[${chatId}] -> (${summarizeUsage(
      {
        inputTokens: state.sdkInputTokens,
        outputTokens: state.sdkOutputTokens,
        cacheRead: state.sdkCacheRead,
        cacheWrite: state.sdkCacheWrite,
      },
      { durationMs, toolCalls: state.toolCalls },
    )})`,
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
