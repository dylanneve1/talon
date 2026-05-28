/**
 * OpenAI Agents backend message handler.
 *
 * Drives a single-agent run on top of `@openai/agents`'s `run()`
 * function in streaming mode. Shares the non-SDK-specific primitives
 * with the other backends via `../shared/`:
 *
 *   - Stream state accumulator (text, tool calls, trailing prose).
 *   - Tool-use detection + turn-terminator handling.
 *   - Model-fallback / context-overflow / session-expiry recovery
 *     via `applyRetryDecision`.
 *   - First-turn system-prompt rebuild + plugin prompt additions.
 *   - `[YYYY-MM-DD HH:MM:SS] [Name] [msg_id:N]` prompt formatting.
 *   - Unified delivery routing.
 *
 * What's OpenAI-Agents-specific (lives here):
 *
 *   - Constructing the `Agent` with `MCPServerStdio[]` from Talon's
 *     plugin map.
 *   - Iterating the `StreamedRunResult` and translating
 *     `RunItemStreamEvent` events (`tool_called`,
 *     `message_output_created`, etc.) into shared stream-state
 *     mutations.
 *   - `.cancel()` on the run when a terminator tool fires, so the
 *     model loop stops without the wrap-up round-trip.
 *
 * Limitations vs the other backends (acknowledged debt for v0):
 *
 *   - No session persistence. The Agents SDK supports sessions via
 *     the `Session` abstraction but Talon's session model is per-chat
 *     numeric ids; wiring is a future PR.
 *   - No progress-text emission before tool calls (the Agents SDK's
 *     raw-stream events don't cleanly split into pre-tool text
 *     segments the way Claude SDK's do).
 *   - No flow-violation reminder retry — single-pass for now.
 */

import { Agent, run } from "@openai/agents";
import type { QueryParams, QueryResult } from "../../core/types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionName,
  resetSession,
} from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
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
} from "../shared/index.js";
import { detectFlowViolation } from "../shared/flow-violation.js";

import {
  OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX,
  OPENAI_AGENTS_DEFAULT_MODEL,
  OPENAI_AGENTS_MAX_TURNS,
  OPENAI_AGENTS_AGENT_NAME,
} from "./constants.js";
import { getState, getOrCreateSession } from "./state.js";
import { getActiveFrontends } from "./init.js";
import { getOrCreateBundle } from "./mcp-pool.js";
import { OPENAI_AGENTS_BUILTIN_TOOLS } from "./builtins.js";

// ── Local utility ───────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// ── Active abort registry ───────────────────────────────────────────────────
//
// Tracks the in-flight abort controller per chat so gateway actions
// (e.g. user-driven cancel) can stop a running turn.

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
    throw new Error("OpenAI Agents backend not initialized");
  }

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

  // Resolve the active model — chat-settings → config → default.
  const chatSettings = getChatSettings(chatId);
  const activeModel =
    params.model ??
    chatSettings.model ??
    config.model ??
    OPENAI_AGENTS_DEFAULT_MODEL;
  log("agent", `[${chatId}] OpenAI Agents model resolved: ${activeModel}`);

  // First-turn system-prompt rebuild + Agents-specific delivery suffix.
  const systemPrompt = prepareSystemPrompt({
    config,
    previousTurns,
    backendSuffix: OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX,
  });

  const prompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId,
  });

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  // Acquire the per-chat MCP bundle. Persistent across turns — built
  // on first use, kept alive until `releaseBundle(chatId)` (chat
  // rebind, /reset, backend cleanup). Avoids the ~15-subprocess
  // re-spawn that the original per-turn build caused, which slowed
  // every turn by ~5s and intermittently raced into
  // `MCP error -32001: Request timed out`. See `mcp-pool.ts`.
  const bridgeUrl = `http://127.0.0.1:${state.gatewayPortFn()}`;
  const frontends = getActiveFrontends();
  let mcpBundle: Awaited<ReturnType<typeof getOrCreateBundle>>;
  try {
    mcpBundle = await getOrCreateBundle({
      chatId,
      bridgeUrl,
      frontends,
      braveApiKey: config.braveApiKey,
    });
  } catch (err) {
    logError(
      "agent",
      `[${chatId}] OpenAI Agents: MCP setup failed: ${errMsg(err)}`,
    );
    throw err;
  }

  const streamState = createStreamState();
  const seenToolCallIds = new Set<string>();
  const abortController = new AbortController();
  activeAborts.set(chatId, abortController);

  const setupMs = Date.now() - t0;
  let turnMs = 0;

  try {
    const turnStart = Date.now();

    // Build the agent. `tools` carries the filesystem + shell built-ins
    // (Read / Write / Edit / Bash / Glob / Grep) so this backend has
    // parity with the Claude SDK backend, which gets equivalent tools
    // bundled by Claude Code. `mcpServers` carries the Talon frontend
    // + plugin MCP servers (Telegram tools, Discord tools, mempalace,
    // etc.). Single agent, no handoffs, no guardrails.
    //
    // `mcpConfig.includeServerInToolNames` tells the Agents SDK to
    // namespace every MCP tool as `mcp_<serverName>__<toolName>` —
    // this eliminates the "Duplicate tool names found across MCP
    // servers" error by construction. Talon legitimately ships
    // colliding names across plugins (Telegram's `cancel_scheduled`
    // for scheduled messages vs. the email plugin's `cancel_scheduled`
    // for scheduled emails, etc.) and namespacing keeps BOTH tools
    // available to the model rather than silently dropping the loser.
    // Built-in tools (Read/Write/Edit/Bash/...) stay unprefixed —
    // the SDK only renames MCP-sourced tools.

    // Diagnostic — enumerate every tool the model will see this turn
    // (both built-in function tools and any MCP server tools). Critical
    // for tracking down "model never calls end_turn" complaints: if
    // end_turn isn't in this list, the model literally cannot call it
    // and the problem is in the MCP server registration, not the model.
    // Note: with namespacing on, names appear as `mcp_<server>__<tool>`.
    try {
      const builtinNames = OPENAI_AGENTS_BUILTIN_TOOLS.map((t) => t.name);
      const mcpToolLists = await Promise.all(
        mcpBundle.servers.map((s) =>
          s
            .listTools()
            .then((ts: Array<{ name?: string }>) =>
              ts.map((t) => t.name ?? "?"),
            )
            .catch(() => [] as string[]),
        ),
      );
      const mcpNames = mcpToolLists.flat();
      log(
        "agent",
        `[${chatId}] tools registered: builtins=[${builtinNames.join(", ")}] mcp=[${mcpNames.join(", ")}]`,
      );
    } catch {
      /* best-effort diagnostic */
    }

    const agent = new Agent({
      name: OPENAI_AGENTS_AGENT_NAME,
      instructions: systemPrompt,
      model: activeModel,
      tools: [...OPENAI_AGENTS_BUILTIN_TOOLS],
      mcpServers: mcpBundle.servers,
      mcpConfig: { includeServerInToolNames: true },
    });

    // Per-chat MemorySession so the SDK preserves the full
    // multi-turn record (model outputs, tool calls + results,
    // reasoning items where the provider supplies them). Without
    // this, every turn starts blind to what was said or done before
    // and the model hallucinates context — e.g. claiming it can't
    // access a file it wrote in the previous turn.
    const stream = await run(agent, prompt, {
      stream: true,
      maxTurns: OPENAI_AGENTS_MAX_TURNS,
      signal: abortController.signal,
      session: getOrCreateSession(chatId),
    });

    for await (const event of stream) {
      if (abortController.signal.aborted && !streamState.turnTerminated) break;

      if (event.type === "run_item_stream_event") {
        handleRunItem(event, {
          state: streamState,
          seenToolCallIds,
          onToolUse,
          chatId,
        });
      }
      // `raw_model_stream_event` and `agent_updated_stream_event`
      // events are intentionally not surfaced — token-by-token
      // streaming would expose private chain-of-thought scratchpad
      // to the chat; the final-message event is enough.

      // Terminator-driven abort. The SDK emits TWO events for each
      // tool call:
      //   1. `tool_called`  — model decided to invoke; RPC about to run.
      //                       `recordToolUse` flips `turnTerminated`
      //                       when the tool is `end_turn` / `react`.
      //   2. `tool_output`  — RPC has completed; the message has
      //                       reached Telegram (for delivery tools).
      //
      // We must NOT abort on `tool_called` — that cancels the
      // in-flight RPC and the message never ships. Aborting on
      // `tool_output` after we've already flagged the turn as
      // terminated means the delivery happened AND we skip the SDK's
      // natural wrap-up round-trip, which otherwise burns 5–10s of
      // typing-indicator with no user-visible output (visible to the
      // user as "Jeff is typing…" lingering after the reply lands).
      if (
        streamState.turnTerminated &&
        event.type === "run_item_stream_event" &&
        (event as { name?: string }).name === "tool_output" &&
        !abortController.signal.aborted
      ) {
        log(
          "agent",
          `[${chatId}] terminator tool result received — aborting wrap-up`,
        );
        try {
          abortController.abort();
        } catch (err) {
          logWarn("agent", `[${chatId}] abort failed: ${errMsg(err)}`);
        }
      }
    }

    // Await the final completion so usage + final state are populated.
    // `completed` resolves after the stream drains; safe to call even
    // when we aborted via the terminator (resolves to the partial
    // state).
    await stream.completed.catch(() => {
      /* swallow — aborted-by-terminator path */
    });

    // Token usage from the underlying RunResult. The SDK aggregates
    // `usage` across all turns in the loop. `_context` is named with
    // an underscore in the SDK type but is structurally public.
    const usage = (
      stream.state as unknown as {
        _context?: {
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            inputTokensDetails?: { cachedTokens?: number };
          };
        };
      }
    )._context?.usage;
    if (usage) {
      recordTokens(streamState, {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheRead: usage.inputTokensDetails?.cachedTokens ?? 0,
        cacheWrite: 0, // OpenAI Responses API doesn't report cache writes.
      });
    }

    turnMs = Date.now() - turnStart;
  } catch (err) {
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
          `[${chatId}] OpenAI Agents ${decision.reason}, resetting session and retrying`,
        );
        resetSession(chatId);
        // MCP bundle is retained across the retry — subprocesses are
        // stateless wrt the model conversation. See `mcp-pool.ts`.
        return handleMessage(params, true);
      }

      if (decision.kind === "fallback_model") {
        logWarn(
          "agent",
          `[${chatId}] ${classified.reason}, falling back to ${decision.fallbackModelId}`,
        );
        resetSession(chatId);
        return await handleMessage(
          { ...params, model: decision.fallbackModelId },
          true,
        );
      }

      logError(
        "agent",
        `[${chatId}] OpenAI Agents error: ${classified.message}`,
      );
      throw classified;
    }
  } finally {
    if (activeAborts.get(chatId) === abortController) {
      activeAborts.delete(chatId);
    }
    // MCP bundle is NOT closed here — it persists across turns via
    // the pool in `mcp-pool.ts`. Release happens on chat rebind, on
    // `/reset` (via `releaseBundle(chatId)`), and at backend cleanup
    // (`releaseAllBundles()`).
  }

  // ── Post-loop accounting ──────────────────────────────────────────────────

  const responseText = finalizeResponseText(streamState);
  const durationMs = Date.now() - t0;
  recordHistogram("response_latency_ms", durationMs);
  incrementCounter("queries_total");

  recordUsage(chatId, {
    inputTokens: streamState.sdkInputTokens,
    outputTokens: streamState.sdkOutputTokens,
    cacheRead: streamState.sdkCacheRead,
    cacheWrite: streamState.sdkCacheWrite,
    durationMs,
    model: activeModel,
  });

  // ── Trailing-prose contract + flow-violation retry ──────────────────────
  // Mirrors the claude-sdk handler. The model's output stream is private
  // scratchpad: replies MUST go through `end_turn` (canonical) or `send`
  // (mid-turn rich content; doesn't close the turn). If the model wrote
  // prose without calling either, the user would see nothing — so we
  // re-prompt once with a synthetic reminder describing the correct
  // flow. A second violation after the retry accepts a silent drop.
  //
  // Only enforced when delivery tools are actually registered. With
  // `frontend: "terminal"` (and the integration-test bootstrap), no
  // frontend MCP server spawns and there's no `end_turn` to call —
  // forcing the contract there would loop forever. Production frontends
  // (Telegram, Discord, Teams) always wire at least one MCP server, so
  // a non-empty `mcpBundle.servers` is the cheap signal we have
  // delivery tools available.
  //
  // `incrementTurns` is deferred until AFTER the check so the retry path
  // (which recurses through `handleMessage` and increments there) doesn't
  // double-count a single user message.
  const violation =
    mcpBundle.servers.length > 0
      ? detectFlowViolation({
          trailingText: streamState.lastTrailingText,
          turnTerminated: streamState.turnTerminated,
          deliveredTextNorms: streamState.deliveredTextNorms,
          retried: _retried,
        })
      : ({ violated: false } as const);

  if (violation.violated) {
    incrementCounter("scratchpad.trailing_text_dropped");
    log(
      "agent",
      `[${chatId}] flow violation: trailing prose (${violation.trailing.length} chars) without end_turn/send. ${
        violation.shouldRetry
          ? "Re-prompting with reminder."
          : "Already retried — accepting silent drop."
      }`,
    );

    if (violation.shouldRetry) {
      incrementCounter("scratchpad.flow_violation_retried");
      // Recursive call owns the `incrementTurns` for this user message.
      return handleMessage({ ...params, text: violation.reminder }, true);
    }
  }

  // Reached the non-retry path — this turn counts as one user-visible turn.
  incrementTurns(chatId);

  // Set a descriptive session name from the user's *first* message.
  // Guarded by `!_retried` so the FLOW_VIOLATION_REMINDER doesn't get
  // captured as the session name when the retry recurses through this
  // path with `params.text = reminder`.
  if (previousTurns === 0 && !_retried) {
    const name = extractSessionName(text);
    if (name) setSessionName(chatId, name);
  }

  // ── Delivery ──────────────────────────────────────────────────────────────
  // Strict tool-only delivery — replies must reach the user via a
  // delivery tool (`end_turn` / `send` / `react`). Trailing prose
  // is private scratchpad and is NEVER shipped as a fallback. The
  // flow-violation retry above gave the model one chance; persistent
  // violators get silently dropped, which is the documented
  // contract.
  //
  // routeDelivery is only invoked when there's something to ship via
  // its established routes (delivered-via-tools text or a synthetic
  // upstream error). Empty turns and trailing-prose-only turns return
  // without any output.
  const hasDeliverable =
    streamState.deliveredTextNorms.length > 0 || !!streamState.syntheticError;
  const delivery = hasDeliverable
    ? await routeDelivery({
        backendLabel: "OpenAI Agents",
        chatId,
        state: streamState,
        responseText: "",
        onTextBlock,
      })
    : { route: "silent" as const, chars: 0 };

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

interface HandleRunItemContext {
  state: ReturnType<typeof createStreamState>;
  seenToolCallIds: Set<string>;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  chatId: string;
}

/**
 * Translate one `RunItemStreamEvent` into stream-state mutations.
 *
 * The Agents SDK emits these as the agent loop progresses:
 *
 *   - `tool_called` — the model decided to call a tool. We record the
 *     tool use + check for turn terminators (`end_turn` / `send` /
 *     `react`).
 *   - `message_output_created` — the model produced a (possibly
 *     final) assistant message. We capture the text for the trailing-
 *     prose delivery path.
 *   - Other event names (`handoff_*`, `reasoning_item_created`,
 *     `tool_search_*`, `tool_approval_requested`) — silently ignored.
 *     Talon doesn't use the SDK's handoff or guardrail features.
 */
function handleRunItem(
  event: { name: string; item: unknown },
  ctx: HandleRunItemContext,
): void {
  switch (event.name) {
    case "tool_called":
      handleToolCalled(event.item, ctx);
      return;
    case "message_output_created":
      handleMessageOutput(event.item, ctx);
      return;
    default:
      // Other events don't map to Talon's reply channel.
      return;
  }
}

/** Pull a tool call out of the item payload and feed it into stream state. */
function handleToolCalled(item: unknown, ctx: HandleRunItemContext): void {
  // RunItem shapes for tool calls vary by tool kind (function tool /
  // MCP tool / hosted tool); the common surface is `rawItem` with the
  // tool name + arguments + id. Defensive narrowing.
  if (!item || typeof item !== "object") return;
  const raw = (item as { rawItem?: Record<string, unknown> }).rawItem;
  if (!raw || typeof raw !== "object") return;
  // Log a compact view of every tool call so we can correlate
  // tools=N / terminator / delivered numbers with the model's actual
  // intent in production. Truncated to keep the log light.
  try {
    const rawName = typeof raw.name === "string" ? raw.name : "?";
    const rawArgs =
      typeof raw.arguments === "string"
        ? raw.arguments.slice(0, 200)
        : JSON.stringify(raw.arguments ?? {}).slice(0, 200);
    log("agent", `[${ctx.chatId}] tool_call ${rawName} args=${rawArgs}`);
  } catch {
    /* skip */
  }

  // MCP tool calls expose `name` (the bare tool name) and `arguments`
  // (the JSON-decoded input). Function tool calls use the same fields.
  const toolName =
    typeof raw.name === "string"
      ? raw.name
      : typeof (raw as { tool?: string }).tool === "string"
        ? (raw as { tool: string }).tool
        : "tool";
  const callId =
    typeof raw.callId === "string"
      ? raw.callId
      : typeof raw.id === "string"
        ? raw.id
        : undefined;

  // Dedup against repeated emissions for the same call id.
  if (callId && ctx.seenToolCallIds.has(callId)) return;
  if (callId) ctx.seenToolCallIds.add(callId);

  // `arguments` arrives as either an already-parsed object or a JSON
  // string (depending on the tool kind). Normalise to a record.
  let input: Record<string, unknown> = {};
  const argsField = raw.arguments;
  if (argsField && typeof argsField === "object") {
    input = argsField as Record<string, unknown>;
  } else if (typeof argsField === "string") {
    try {
      const parsed = JSON.parse(argsField);
      if (parsed && typeof parsed === "object") {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      /* leave input empty — best-effort */
    }
  }

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
      `[OpenAI Agents] terminator fired: ${describeToolCall(toolName, input)}`,
    );
  }
}

/** Pull the assistant message text out of a `message_output_created` event. */
function handleMessageOutput(item: unknown, ctx: HandleRunItemContext): void {
  if (!item || typeof item !== "object") return;
  const raw = (item as { rawItem?: Record<string, unknown> }).rawItem;
  if (!raw || typeof raw !== "object") return;

  // The Responses API message shape is `{ role: "assistant", content: [{type: "output_text", text: "..."}, ...] }`.
  // Walk the content array and pick up text segments.
  const content = (raw as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return;

  let combined = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: unknown };
    if (
      (p.type === "output_text" || p.type === "text") &&
      typeof p.text === "string"
    ) {
      combined += p.text;
    }
  }

  if (combined.trim()) {
    ctx.state.allResponseText = combined;
    ctx.state.lastTrailingText = combined;
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
