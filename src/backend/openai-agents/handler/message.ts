/**
 * OpenAI Agents backend message handler.
 *
 * Drives a single-agent run on top of `@openai/agents`'s `run()` in streaming
 * mode. Shares the non-SDK-specific primitives with the other backends via
 * `../../shared/`. OpenAI-Agents-specific bits: building the `Agent` with the
 * per-chat MCP bundle, iterating the `StreamedRunResult` (see `events.ts`),
 * `.cancel()` on terminator, and the trailing-prose flow-violation retry.
 */

import { Agent, run } from "@openai/agents";
import type { QueryParams, QueryResult } from "../../shared/handler-types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionName,
  resetSession,
} from "../../../storage/sessions.js";
import { getChatSettings } from "../../../storage/chat-settings.js";
import { classify } from "../../../core/errors.js";
import { log, logError, logWarn } from "../../../util/log.js";
import { traceMessage } from "../../../util/trace.js";
import { incrementCounter } from "../../../util/metrics.js";

import {
  createStreamState,
  recordTokens,
  finalizeResponseText,
  formatUserPrompt,
  prepareSystemPrompt,
  extractSessionName,
  classifyRetry,
  summarizeUsage,
  routeDelivery,
  buildFirstTurnReminder,
  buildFlowViolationReminder,
  recordTurnMetrics,
  recordFailedTurnAccounting,
  recordFlowViolation,
} from "../../shared/index.js";
import {
  detectFlowViolation,
  FLOW_VIOLATION_MAX_RETRIES,
} from "../../shared/flow-violation.js";

import {
  buildOpenAiAgentsSuffix,
  OPENAI_AGENTS_DEFAULT_MODEL,
  OPENAI_AGENTS_MAX_TURNS,
  OPENAI_AGENTS_AGENT_NAME,
} from "../constants.js";
import { getState, getOrCreateSession } from "../state.js";
import { getActiveFrontends } from "../init.js";
import { frontendsForChat } from "../../shared/frontends.js";
import { getOrCreateBundle } from "../mcp-pool.js";
import { OPENAI_AGENTS_BUILTIN_TOOLS } from "../builtins.js";
import { activeAborts } from "./state.js";
import { handleRunItem } from "./events.js";

// ── Local utility ───────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Read the aggregated usage off a run's state. `_context` is named with
 * an underscore in the SDK type but is structurally public; the SDK
 * updates it as each model call in the agentic loop completes, so this
 * is valid both mid-stream (live stats) and after `stream.completed`.
 */
function readRunUsage(runState: unknown):
  | {
      inputTokens?: number;
      outputTokens?: number;
      inputTokensDetails?: { cachedTokens?: number };
    }
  | undefined {
  return (
    runState as {
      _context?: {
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          inputTokensDetails?: { cachedTokens?: number };
        };
      };
    }
  )._context?.usage;
}

export async function handleMessage(
  params: QueryParams,
  _retried = false,
  _flowRetries = 0,
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

  // The chat's OWNING messaging frontend (falling back to the primary
  // for cross-surface chats) drives the delivery-contract suffix and
  // the frontend-aware flow-violation/first-turn text — tool names
  // differ per frontend. Empty in terminal mode (no delivery tools —
  // contract enforcement is skipped below anyway).
  const frontends = getActiveFrontends();
  const frontend: string | undefined = frontendsForChat(chatId, frontends)[0];

  // Per-session frozen prompt + Agents-specific delivery suffix.
  const { text: systemPrompt } = prepareSystemPrompt({
    config,
    previousTurns,
    backendSuffix: buildOpenAiAgentsSuffix(frontend ?? "telegram"),
    chatId,
    sessionEpoch: session.createdAt,
  });

  let prompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId,
  });
  // First-turn nudge — turn 0 is where flow violations cluster, and one
  // line in the user message costs nothing on later turns and never
  // touches the cached prefix.
  if (frontend && previousTurns === 0 && !_retried && _flowRetries === 0) {
    prompt += `\n\n${buildFirstTurnReminder(frontend)}`;
  }

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  // Acquire the per-chat MCP bundle. Persistent across turns — built on
  // first use, kept alive until `releaseBundle(chatId)`. Avoids the
  // ~15-subprocess re-spawn the original per-turn build caused.
  const bridgeUrl = `http://127.0.0.1:${state.gatewayPortFn()}`;
  let mcpBundle: Awaited<ReturnType<typeof getOrCreateBundle>>;
  try {
    mcpBundle = await getOrCreateBundle({
      chatId,
      bridgeUrl,
      frontends,
      braveApiKey: config.braveApiKey,
      toolExclusions: config,
    });
  } catch (err) {
    logError(
      "agent",
      `[${chatId}] OpenAI Agents: MCP setup failed: ${errMsg(err)}`,
    );
    throw err;
  }

  // Bind the stream state to the chat so token mutators mirror counts
  // into the live-turn overlay — /status updates while the turn runs.
  const streamState = createStreamState(chatId);
  const seenToolCallIds = new Set<string>();
  const abortController = new AbortController();
  activeAborts.set(chatId, abortController);

  const setupMs = Date.now() - t0;
  let turnMs = 0;

  try {
    const turnStart = Date.now();

    // Build the agent. `tools` carries the filesystem + shell built-ins
    // for parity with the Claude SDK backend; `mcpServers` carries the
    // Talon frontend + plugin MCP servers. Single agent, no handoffs.
    // `mcpConfig.includeServerInToolNames` namespaces MCP tools as
    // `mcp_<serverName>__<toolName>` so colliding names across plugins
    // both stay available. Built-in tools stay unprefixed.

    // Diagnostic — enumerate every tool the model will see this turn.
    // Critical for tracking down "model never calls end_turn": if it
    // isn't in this list, the problem is MCP registration, not the model.
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

    // Per-chat MemorySession so the SDK preserves the full multi-turn
    // record (model outputs, tool calls + results, reasoning items).
    // Without this, every turn starts blind to prior context.
    const stream = await run(agent, prompt, {
      stream: true,
      maxTurns: OPENAI_AGENTS_MAX_TURNS,
      signal: abortController.signal,
      session: getOrCreateSession(chatId),
    });

    // The Agents SDK aggregates usage on the run context as each model
    // call completes — sample it (throttled) so the live-turn overlay
    // tracks the agentic loop instead of jumping from 0 to final.
    let lastLiveUsagePushAt = 0;
    const pushRunUsageLive = (): void => {
      const now = Date.now();
      if (now - lastLiveUsagePushAt < 1000) return;
      lastLiveUsagePushAt = now;
      const u = readRunUsage(stream.state);
      if (!u) return;
      recordTokens(streamState, {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheRead: u.inputTokensDetails?.cachedTokens ?? 0,
        cacheWrite: 0, // OpenAI Responses API doesn't report cache writes.
      });
    };

    for await (const event of stream) {
      if (abortController.signal.aborted && !streamState.turnTerminated) break;

      if (event.type === "run_item_stream_event") {
        handleRunItem(event, {
          state: streamState,
          seenToolCallIds,
          onToolUse,
          chatId,
        });
        pushRunUsageLive();
      }
      // `raw_model_stream_event` and `agent_updated_stream_event`
      // events are intentionally not surfaced — token-by-token streaming
      // would expose private chain-of-thought; the final-message event
      // is enough.

      // Terminator-driven abort. The SDK emits TWO events for each tool
      // call: `tool_called` (RPC about to run) and `tool_output` (RPC
      // completed; message reached the frontend). We must NOT abort on
      // `tool_called` — that cancels the in-flight RPC and the message
      // never ships. Aborting on `tool_output` after we've flagged the
      // turn terminated means delivery happened AND we skip the SDK's
      // wrap-up round-trip (otherwise 5–10s of lingering typing).
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
    // Safe to call even when we aborted via the terminator (resolves to
    // the partial state).
    await stream.completed.catch(() => {
      /* swallow — aborted-by-terminator path */
    });

    // Token usage from the underlying RunResult. The SDK aggregates
    // `usage` across all turns in the loop.
    const usage = readRunUsage(stream.state);
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

      // Terminal failure — account for whatever the turn consumed before
      // dying and drop the live overlay (the retry branches above re-enter
      // handleMessage, which does its own accounting).
      recordFailedTurnAccounting({
        backend: "openai-agents",
        chatId,
        durationMs: Date.now() - t0,
        toolCalls: streamState.toolCalls,
        apiCalls: streamState.numApiCalls,
        model: activeModel,
        usage: {
          inputTokens: streamState.sdkInputTokens,
          outputTokens: streamState.sdkOutputTokens,
          cacheRead: streamState.sdkCacheRead,
          cacheWrite: streamState.sdkCacheWrite,
        },
        contextTokens: streamState.contextTokens,
        contextWindow: streamState.contextWindow,
      });

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
    // MCP bundle is NOT closed here — it persists across turns via the
    // pool in `mcp-pool.ts`. Release happens on chat rebind, `/reset`, and
    // at backend cleanup.
  }

  // ── Post-loop accounting ──────────────────────────────────────────────────

  const responseText = finalizeResponseText(streamState);
  const durationMs = Date.now() - t0;
  recordTurnMetrics({
    chatId,
    backend: "openai-agents",
    durationMs,
    toolCalls: streamState.toolCalls,
    apiCalls: streamState.numApiCalls,
    usage: {
      inputTokens: streamState.sdkInputTokens,
      outputTokens: streamState.sdkOutputTokens,
      cacheRead: streamState.sdkCacheRead,
      cacheWrite: streamState.sdkCacheWrite,
    },
  });

  recordUsage(chatId, {
    inputTokens: streamState.sdkInputTokens,
    outputTokens: streamState.sdkOutputTokens,
    cacheRead: streamState.sdkCacheRead,
    cacheWrite: streamState.sdkCacheWrite,
    durationMs,
    model: activeModel,
  });

  // ── Trailing-prose contract + flow-violation retry ──────────────────────
  // Replies MUST go through `end_turn` (canonical) or `send` (mid-turn).
  // If the model wrote prose without calling either, the user would see
  // nothing — re-prompt once with a synthetic reminder. A second violation
  // accepts a silent drop. Only enforced when delivery tools are registered
  // (non-empty mcpBundle.servers). `incrementTurns` is deferred until AFTER
  // the check so the retry path doesn't double-count.
  const violation =
    mcpBundle.servers.length > 0
      ? detectFlowViolation({
          trailingText: streamState.lastTrailingText,
          turnTerminated: streamState.turnTerminated,
          deliveredTextNorms: streamState.deliveredTextNorms,
          toolCalls: streamState.toolCalls,
          retried: _flowRetries > 0,
          retryCount: _flowRetries,
          maxRetries: FLOW_VIOLATION_MAX_RETRIES,
          ...(frontend
            ? { reminder: buildFlowViolationReminder(frontend) }
            : {}),
        })
      : ({ violated: false } as const);

  if (violation.violated) {
    recordFlowViolation(
      chatId,
      violation.shouldRetry ? "retried" : "cap_exhausted",
    );
    log(
      "agent",
      `[${chatId}] flow violation: trailing prose (${violation.trailing.length} chars) without end_turn/send. ${
        violation.shouldRetry
          ? "Re-prompting with reminder."
          : "Already retried — accepting silent drop."
      }`,
    );

    if (violation.shouldRetry) {
      // Recursive call owns the `incrementTurns` for this user message.
      return handleMessage(
        { ...params, text: violation.reminder },
        _retried,
        _flowRetries + 1,
      );
    }
  }

  // Reached the non-retry path — this turn counts as one user-visible turn.
  incrementTurns(chatId);

  // Set a descriptive session name from the user's *first* message.
  // Guarded by `!_retried` so the reminder doesn't get captured as the
  // session name when the retry recurses with `params.text = reminder`.
  if (previousTurns === 0 && !_retried && _flowRetries === 0) {
    const name = extractSessionName(text);
    if (name) setSessionName(chatId, name);
  }

  // ── Delivery — strict tool-only ──────────────────────────────────────────
  // Replies must reach the user via a delivery tool. Trailing prose is
  // private scratchpad and is NEVER shipped as a fallback. routeDelivery is
  // only invoked when there's something to ship (delivered-via-tools text or
  // a synthetic upstream error).
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
