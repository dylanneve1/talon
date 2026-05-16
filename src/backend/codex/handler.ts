/**
 * Codex main message handler.
 *
 * Orchestrates the full turn lifecycle on top of `@openai/codex-sdk`'s
 * `Thread.runStreamed`. Shares the non-SDK-specific primitives with
 * the other backends via `../shared/`:
 *
 *   - Stream state accumulator (text, tool calls, trailing prose).
 *   - Tool-use detection + turn-terminator handling
 *     (`end_turn` / `send` / `react`).
 *   - Progress-text emission before each tool call.
 *   - Model fallback on rate-limit / overload / network.
 *   - Context-overflow + session-expiry recovery.
 *   - First-turn system-prompt rebuild + plugin prompt additions.
 *   - `[YYYY-MM-DD HH:MM:SS] [Name] [msg_id:N]` prompt formatting.
 *   - Unified delivery routing
 *     (tool / synthetic-error / text-part / empty).
 *
 * What's Codex-specific (lives here, not in shared):
 *
 *   - Reading events from Codex's `runStreamed` generator
 *     (`thread.started`, `turn.started`, `item.completed`,
 *     `turn.completed`, `turn.failed`, `error`).
 *   - Translating `agent_message` / `mcp_tool_call` items into the
 *     shared stream state.
 *   - Resuming via `codex.resumeThread(id)` for session continuity.
 *
 * Why no `session.abort()`: the Codex SDK's `runStreamed` accepts an
 * `AbortSignal` on the per-call options. We hook it up so a
 * turn-terminator tool can cancel any further model generation the
 * same way Kilo's `oc.session.abort()` does — without burning the
 * wrap-up round-trip.
 */

import type {
  Thread,
  ThreadEvent,
  ThreadItem,
  AgentMessageItem,
  McpToolCallItem,
  Usage,
} from "@openai/codex-sdk";
import type { QueryParams, QueryResult } from "../../core/types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionName,
  setSessionId,
  resetSession,
} from "../../storage/sessions.js";
import { getChatSettings, setChatModel } from "../../storage/chat-settings.js";
import { classify } from "../../core/errors.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { incrementCounter, recordHistogram } from "../../util/metrics.js";
import { isTurnTerminator, stripMcpPrefix } from "../../core/tools/index.js";

import {
  createStreamState,
  recordToolUse,
  recordTokens,
  finalizeResponseText,
  formatUserPrompt,
  prepareSystemPrompt,
  extractSessionName,
  classifyRetry,
  summarizeUsage,
  routeDelivery,
  type StreamState,
} from "../shared/index.js";

import {
  CODEX_SYSTEM_PROMPT_SUFFIX,
  CODEX_DEFAULT_MODEL,
} from "./constants.js";
import { getState } from "./state.js";
import { ensureCodex } from "./init.js";

// ── Local utility ───────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// ── Active session registry ─────────────────────────────────────────────────

/** Tracks the in-flight abort controller per chat so cancellations can land. */
const activeAborts = new Map<string, AbortController>();

/** Get the in-flight abort controller for a chat, if a turn is running. */
export function getActiveAbort(chatId: string): AbortController | undefined {
  return activeAborts.get(chatId);
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  const state = getState();
  const config = state.config;
  if (!config) {
    throw new Error("Codex agent not initialized");
  }
  const codex = ensureCodex(params.chatId);

  const {
    chatId,
    text,
    senderName,
    isGroup,
    messageId,
    onTextBlock,
    onToolUse,
  } = params;
  const t0 = Date.now();
  const session = getSession(chatId);
  const previousTurns = session.turns;

  // Resolve active model. Codex accepts arbitrary model strings; we
  // pass through whatever the chat settings hold (default `gpt-5-codex`).
  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.model ?? CODEX_DEFAULT_MODEL;
  log("agent", `[${chatId}] Codex model resolved: ${activeModel}`);

  // First-turn system-prompt rebuild + Codex-specific delivery suffix.
  const systemPrompt = prepareSystemPrompt({
    config,
    previousTurns,
    backendSuffix: CODEX_SYSTEM_PROMPT_SUFFIX,
  });

  const prompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId,
  });

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  // Resume an existing Codex thread or start a fresh one. Codex
  // persists threads under `~/.codex/sessions/`; we store the thread
  // id in Talon's session storage so `resumeThread()` keeps the
  // conversation continuous across turns.
  const thread: Thread = session.sessionId
    ? codex.resumeThread(session.sessionId, {
        model: activeModel,
        skipGitRepoCheck: true,
      })
    : codex.startThread({
        model: activeModel,
        skipGitRepoCheck: true,
      });

  const streamState = createStreamState();
  const seenToolCallIds = new Set<string>();
  const abortController = new AbortController();
  activeAborts.set(chatId, abortController);

  let usage: Usage | null = null;
  let turnFailedError: string | undefined;
  let resolvedThreadId: string | undefined;

  const setupMs = Date.now() - t0;
  let turnMs = 0;

  try {
    const turnStart = Date.now();

    // Codex SDK supports passing a `system` prompt through the runtime
    // config. We thread it in via the `runStreamed` call so the agent
    // sees Talon's identity / memory / workspace listing.
    //
    // Note: Codex's SDK does not currently expose `system` directly on
    // `runStreamed`; system prompts are baked at thread creation via
    // the CLI's config. Talon-side workaround: prepend the system
    // prompt to the user prompt as a fenced "INSTRUCTIONS" block on
    // the first turn only. Subsequent turns inherit instructions from
    // the resumed thread.
    const inputText =
      previousTurns === 0 ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

    const { events } = await thread.runStreamed(inputText, {
      signal: abortController.signal,
    });

    for await (const event of events) {
      if (abortController.signal.aborted && !streamState.turnTerminated) break;
      handleEvent(event, {
        state: streamState,
        seenToolCallIds,
        onTextBlock,
        onToolUse,
        chatId,
      });

      if (event.type === "thread.started") {
        resolvedThreadId = event.thread_id;
      } else if (event.type === "turn.completed") {
        usage = event.usage;
      } else if (event.type === "turn.failed") {
        turnFailedError = event.error.message;
      } else if (event.type === "error") {
        turnFailedError = event.message;
      }

      // Terminator-driven abort: a delivery tool already shipped the
      // reply via the bridge. Cancel further model generation to skip
      // the wrap-up round-trip Codex would otherwise burn.
      if (streamState.turnTerminated && !abortController.signal.aborted) {
        log("agent", `[${chatId}] terminator fired — aborting Codex turn`);
        try {
          abortController.abort();
        } catch (err) {
          logWarn("agent", `[${chatId}] abort failed: ${errMsg(err)}`);
        }
      }
    }

    turnMs = Date.now() - turnStart;
  } catch (err) {
    // Aborted-by-terminator path is the expected close on `end_turn`.
    if (
      streamState.turnTerminated &&
      (errMsg(err) === "AbortError" || /abort/i.test(errMsg(err)))
    ) {
      // Swallow — turn completed via terminator tool.
    } else {
      const classified = classify(err);
      incrementCounter(`errors.${classified.reason ?? "unknown"}`);

      const decision = classifyRetry({
        error: classified,
        activeModel,
        retried: _retried,
      });

      if (decision.kind === "reset_and_retry") {
        logWarn(
          "agent",
          `[${chatId}] Codex ${decision.reason}, resetting thread and retrying`,
        );
        resetSession(chatId);
        return handleMessage(params, true);
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
          return await handleMessage(params, true);
        } finally {
          setChatModel(chatId, originalModel);
        }
      }

      logError("agent", `[${chatId}] Codex error: ${classified.message}`);
      throw classified;
    }
  } finally {
    if (activeAborts.get(chatId) === abortController) {
      activeAborts.delete(chatId);
    }
  }

  // ── Post-loop accounting ──────────────────────────────────────────────────

  if (resolvedThreadId) {
    const stored = getSession(chatId).sessionId;
    if (stored !== resolvedThreadId) {
      setSessionId(chatId, resolvedThreadId);
    }
  }

  if (usage) {
    recordTokens(streamState, {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheRead: usage.cached_input_tokens,
      cacheWrite: 0, // Codex doesn't report cache writes
    });
  }

  // Surface a synthetic error if Codex failed the turn upstream.
  if (turnFailedError) {
    streamState.syntheticError = turnFailedError;
    incrementCounter("codex.turn_failed");
  }

  const responseText = finalizeResponseText(streamState);
  const durationMs = Date.now() - t0;
  recordHistogram("response_latency_ms", durationMs);
  incrementCounter("queries_total");

  incrementTurns(chatId);
  recordUsage(chatId, {
    inputTokens: streamState.sdkInputTokens,
    outputTokens: streamState.sdkOutputTokens,
    cacheRead: streamState.sdkCacheRead,
    cacheWrite: streamState.sdkCacheWrite,
    durationMs,
    model: activeModel,
  });

  // Set a descriptive session name from the user's first message.
  if (previousTurns === 0) {
    const name = extractSessionName(text);
    if (name) setSessionName(chatId, name);
  }

  // ── Delivery ──────────────────────────────────────────────────────────────
  //
  // Decision tree shared with the other backends — see
  // `backend/shared/delivery.ts` for the full rationale.
  const delivery = await routeDelivery({
    backendLabel: "Codex",
    chatId,
    state: streamState,
    responseText,
    onTextBlock,
  });

  log(
    "agent",
    `[${chatId}] delivery: ${delivery.route} (${delivery.chars} chars)`,
  );

  log(
    "agent",
    `[${chatId}] -> (${summarizeUsage(
      {
        inputTokens: streamState.sdkInputTokens,
        outputTokens: streamState.sdkOutputTokens,
        cacheRead: streamState.sdkCacheRead,
        cacheWrite: streamState.sdkCacheWrite,
      },
      { durationMs, toolCalls: streamState.toolCalls },
    )} terminator=${streamState.turnTerminated ? "yes" : "no"} ` +
      `delivered=${streamState.deliveredTextNorms.length} ` +
      `respLen=${responseText.length} ` +
      `setup=${setupMs}ms turn=${turnMs}ms)`,
  );
  traceMessage(chatId, "out", responseText, {
    durationMs,
    toolCalls: streamState.toolCalls,
  });

  return {
    text: responseText,
    durationMs,
    inputTokens: streamState.sdkInputTokens,
    outputTokens: streamState.sdkOutputTokens,
    cacheRead: streamState.sdkCacheRead,
    cacheWrite: streamState.sdkCacheWrite,
  };
}

// ── Event handler ───────────────────────────────────────────────────────────

interface HandleEventContext {
  state: StreamState;
  seenToolCallIds: Set<string>;
  onTextBlock?: (text: string) => Promise<void>;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  chatId: string;
}

/**
 * Translate one Codex `ThreadEvent` into stream-state mutations.
 *
 * Synchronous — keeps the for-await loop simple. The shared
 * `routeDelivery` step at end-of-turn handles the final emit.
 */
function handleEvent(event: ThreadEvent, ctx: HandleEventContext): void {
  if (event.type !== "item.completed") return;
  handleItem(event.item, ctx);
}

function handleItem(item: ThreadItem, ctx: HandleEventContext): void {
  switch (item.type) {
    case "agent_message":
      handleAgentMessage(item, ctx);
      return;
    case "mcp_tool_call":
      handleMcpToolCall(item, ctx);
      return;
    case "reasoning":
    case "command_execution":
    case "file_change":
    case "web_search":
    case "todo_list":
    case "error":
      // Reasoning is private scratchpad; command/file/web/todo are
      // ambient activity surfaced by Codex's CLI shell. None map to
      // Talon's reply channel. Error items get logged below.
      if (item.type === "error") {
        logWarn("agent", `[${ctx.chatId}] Codex error item: ${item.message}`);
      }
      return;
  }
}

function handleAgentMessage(
  item: AgentMessageItem,
  ctx: HandleEventContext,
): void {
  // agent_message is the model's final reply. Codex emits one per
  // turn with the complete text (no need to accumulate deltas — the
  // SDK has already coalesced them).
  if (typeof item.text === "string" && item.text.trim()) {
    ctx.state.allResponseText = item.text;
    ctx.state.lastTrailingText = item.text;
  }
}

function handleMcpToolCall(
  item: McpToolCallItem,
  ctx: HandleEventContext,
): void {
  if (item.status !== "completed" && item.status !== "in_progress") return;
  if (ctx.seenToolCallIds.has(item.id)) return;
  ctx.seenToolCallIds.add(item.id);

  // Codex names MCP tools as `<server>.<tool>` in the call item; the
  // shared `recordToolUse` / `isTurnTerminator` expect the bare tool
  // name (or `mcp__<server>__<tool>` form). Normalise via the upstream
  // tool name on the item.
  const toolName = item.tool;
  const input =
    item.arguments && typeof item.arguments === "object"
      ? (item.arguments as Record<string, unknown>)
      : {};

  incrementCounter(`tool_calls.${stripMcpPrefix(toolName)}`);
  recordToolUse(ctx.state, toolName, input);

  if (ctx.onToolUse) {
    try {
      ctx.onToolUse(toolName, input);
    } catch {
      /* non-fatal */
    }
  }

  if (!ctx.state.turnTerminated && isTurnTerminator(toolName, input)) {
    ctx.state.turnTerminated = true;
    log(
      "agent",
      `[Codex] terminator fired: ${describeToolCall(toolName, input)}`,
    );
  }
}

/** One-line summary of a tool call for the operator log. */
function describeToolCall(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const parts: string[] = [toolName];
  if (typeof input.type === "string") parts.push(`type=${input.type}`);
  if (typeof input.text === "string") {
    parts.push(`text=${input.text.length}chars`);
  }
  if (typeof input.emoji === "string") parts.push(`emoji=${input.emoji}`);
  if (typeof input.end_turn === "boolean") {
    parts.push(`end_turn=${input.end_turn}`);
  }
  return parts.join(" ");
}
