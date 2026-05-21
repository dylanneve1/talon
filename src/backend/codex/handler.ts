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
  summarizeUsage,
  routeDelivery,
  applyRetryDecision,
  type StreamState,
} from "../shared/index.js";

import {
  CODEX_SYSTEM_PROMPT_SUFFIX,
  CODEX_DEFAULT_MODEL,
  CODEX_CHATGPT_DEFAULT_MODEL,
} from "./constants.js";
import { getState } from "./state.js";
import { ensureCodex, getCodexAuthInfo } from "./init.js";
import { isChatGptModelMismatchError, isSilentOAuthExitError } from "./auth.js";
import { chatGptFallbackFor, isCodexOAuthIncompat } from "./models.js";
import { markOAuthIncompat } from "./oauth-incompat.js";

// ── Local utility ───────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * One-shot ChatGPT-OAuth model-mismatch recovery.
 *
 * Two failure shapes trigger a retry:
 *
 *   1. **Explicit mismatch** — Codex surfaced
 *      `"not supported when using Codex with a ChatGPT account"` via the
 *      JSON event stream or thrown error. This is the easy case.
 *
 *   2. **Silent exit-1 on OAuth** — the Codex CLI rejected the model
 *      *without* emitting the explicit text, exited 1, and the SDK
 *      surfaced only `"Codex Exec exited with code 1: Reading prompt
 *      from stdin..."`. This is what hit Pandario on 2026-05-20 23:13Z
 *      when `gpt-5.4-mini` was selected. To stay correct without
 *      misclassifying genuine non-model failures, the silent-exit path
 *      ONLY fires when:
 *        - The current auth mode is `chatgpt` (otherwise unrelated
 *          failures would be falsely treated as OAuth-incompat);
 *        - The active model isn't already the OAuth flagship
 *          (`gpt-5.5`); a silent exit on `gpt-5.5` means the credential
 *          itself is broken — retrying wouldn't help.
 *
 *      When triggered, the model is recorded into the persisted
 *      `oauth-incompat` store so future turns skip it pre-emptively.
 *
 * Returns a retry promise when either shape triggers AND we haven't
 * already retried (`_retried` sentinel prevents recursion). Returns
 * `undefined` otherwise; the caller falls through to its normal
 * classify/throw path.
 *
 * The retry side-effects are confined here: session reset, transient
 * `setChatModel` flip (restored in `finally`), `_retried = true` on the
 * recursive call.
 */
async function maybeFallbackForChatGptMismatch(
  probeText: string,
  activeModel: string,
  params: QueryParams,
  retried: boolean,
  chatId: string,
): Promise<QueryResult | undefined> {
  if (retried) return undefined;

  const explicit = isChatGptModelMismatchError(probeText);
  const authInfo = getCodexAuthInfo();
  const isOAuth = authInfo?.mode === "chatgpt";
  const silent =
    isOAuth &&
    activeModel !== CODEX_CHATGPT_DEFAULT_MODEL &&
    isSilentOAuthExitError(probeText);

  if (!explicit && !silent) return undefined;

  const fallbackModel =
    chatGptFallbackFor(activeModel) ?? CODEX_CHATGPT_DEFAULT_MODEL;
  if (fallbackModel === activeModel) return undefined;

  // Only EXPLICIT mismatch errors are persisted as OAuth-incompat —
  // they're definitive ("not supported when using Codex with a ChatGPT
  // account" is an unambiguous server-side signal). Silent-exit
  // failures are ambiguous (could be model-incompat, but could also
  // be a transient outage, brief rate-limit, or upstream blip) and
  // would over-poison the learning store if persisted. The silent
  // path still triggers an in-session retry below, just without the
  // permanent record.
  if (isOAuth && explicit) {
    const recorded = markOAuthIncompat(activeModel);
    if (recorded) {
      logWarn(
        "agent",
        `[${chatId}] Codex: recorded ${activeModel} as OAuth-incompat ` +
          `(explicit mismatch) — subsequent turns will skip pre-emptively`,
      );
    }
  }

  const shape = explicit ? "explicit mismatch" : "silent exit (oauth-incompat)";
  logWarn(
    "agent",
    `[${chatId}] Codex ${shape} for ${activeModel}; ` +
      `resetting thread and retrying on ${fallbackModel}. ` +
      (isOAuth
        ? `Set TALON_CODEX_KEY or codexApiKey for billing-based access to api-key-only models.`
        : ``),
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
  // pass through whatever the chat settings hold. The fallback chain
  // is: chat-settings → config → auth-aware default. The auth-aware
  // default is `gpt-5-codex` when an API key is present, `gpt-5.5`
  // when only ChatGPT OAuth is configured (because `gpt-5-codex` is
  // rejected with a 400 on ChatGPT-mode accounts).
  const chatSettings = getChatSettings(chatId);
  const authInfo = getCodexAuthInfo();
  const authAwareDefault =
    authInfo?.mode === "chatgpt"
      ? CODEX_CHATGPT_DEFAULT_MODEL
      : CODEX_DEFAULT_MODEL;
  const requestedModel = chatSettings.model ?? config.model ?? authAwareDefault;
  // If the resolved model is known OAuth-incompat AND we're on
  // ChatGPT OAuth, pre-emptively swap to the chatgpt-compatible
  // fallback rather than letting the first turn fail. Two sources of
  // truth feed `isCodexOAuthIncompat`:
  //
  //   1. **Static** (`isCodexApiKeyOnlyModel`) — curated `apiKeyOnly`
  //      flag in `CODEX_MODELS`. Covers ids known at release time
  //      (`gpt-5-codex`).
  //
  //   2. **Dynamic** (`isKnownOAuthIncompat` via `oauth-incompat.ts`) —
  //      runtime-learned from observed silent-exit failures, persisted
  //      per-credential. Covers cache-discovered ids that the cache
  //      *claims* are `supported_in_api: true` but the CLI rejects on
  //      OAuth (e.g. `gpt-5.4-mini` — see Pandario 23:13Z 2026-05-20).
  //
  // The post-hoc recovery ladder in `maybeFallbackForChatGptMismatch`
  // would catch missed cases too, but pre-emptive saves the ~9s
  // round-trip every subsequent turn and makes the resolved-model log
  // line match what Codex actually sees.
  let activeModel = requestedModel;
  if (authInfo?.mode === "chatgpt" && isCodexOAuthIncompat(requestedModel)) {
    const fallback =
      chatGptFallbackFor(requestedModel) ?? CODEX_CHATGPT_DEFAULT_MODEL;
    // Guard against a learned-but-no-fallback case — only swap when the
    // fallback is actually different from what we'd already run.
    if (fallback !== requestedModel) {
      logWarn(
        "agent",
        `[${chatId}] Codex model ${requestedModel} is OAuth-incompat and ` +
          `current auth is ChatGPT OAuth — pre-emptively falling back to ${fallback}. ` +
          `Set TALON_CODEX_KEY / codexApiKey or change the configured model to silence this.`,
      );
      activeModel = fallback;
    }
  }
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
  //
  // ThreadOptions:
  //   - `skipGitRepoCheck` — Codex normally insists on running inside
  //     a git repo. We're an assistant, not a coding session.
  //   - `sandboxMode: "read-only"` — Talon's tool surface comes from
  //     MCP plugins (mempalace, brave, github, etc.); Codex's own
  //     filesystem / shell tools aren't part of the assistant's job.
  //     Sandbox blocks them silently.
  //   - `approvalPolicy: "never"` — auto-deny any tool that would
  //     otherwise prompt the user. MCP tools execute through the
  //     bridge and bypass this policy entirely.
  //   - `networkAccessEnabled: false` — same reasoning as sandboxMode.
  //     If Codex needs net it goes through the brave-search MCP.
  const threadOptions = {
    model: activeModel,
    skipGitRepoCheck: true,
    sandboxMode: "read-only" as const,
    approvalPolicy: "never" as const,
    networkAccessEnabled: false,
  };
  const thread: Thread = session.sessionId
    ? codex.resumeThread(session.sessionId, threadOptions)
    : codex.startThread(threadOptions);

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
      // ChatGPT-OAuth model-mismatch path: a 400 invalid_request_error
      // saying "not supported when using Codex with a ChatGPT account".
      // Check both the captured event-stream message and the thrown
      // error — Codex SDK surfaces it via both channels.
      const fallback = await maybeFallbackForChatGptMismatch(
        `${turnFailedError ?? ""} ${errMsg(err)}`,
        activeModel,
        params,
        _retried,
        chatId,
      );
      if (fallback) return fallback;

      const outcome = await applyRetryDecision({
        err,
        chatId,
        activeModel,
        retried: _retried,
        params,
        recurseWithRetried: (p) => handleMessage(p, true),
        backendLabel: "Codex",
        resetNoun: "thread",
      });
      if (outcome.retry) return outcome.retry;

      logError(
        "agent",
        `[${chatId}] Codex error: ${outcome.classified.message}`,
      );
      throw outcome.classified;
    }
  } finally {
    if (activeAborts.get(chatId) === abortController) {
      activeAborts.delete(chatId);
    }
  }

  // ── Post-loop accounting ──────────────────────────────────────────────────

  // Event-only ChatGPT-mismatch recovery: if the SDK emitted a
  // `turn.failed` carrying the mismatch text but DIDN'T rethrow, the
  // catch block above never fired. Catch it here too. (Current SDK
  // rethrows in this case, but this path defends against a future
  // change where it only surfaces via the event stream.)
  if (turnFailedError && !_retried) {
    const fallback = await maybeFallbackForChatGptMismatch(
      turnFailedError,
      activeModel,
      params,
      _retried,
      chatId,
    );
    if (fallback) return fallback;
  }

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
  // Only act on `completed`. Codex SDK emits each mcp_tool_call item
  // twice: once with `status: "in_progress"` when it dispatches the
  // tool to the MCP server, and again with `status: "completed"` after
  // the server returns the result. The earlier code accepted both —
  // combined with the `seenToolCallIds` dedup, that meant we acted on
  // whichever shape arrived first (in_progress, every time).
  //
  // For terminator tools (`end_turn` / `send` / `react`) this is a
  // race: marking `turnTerminated` on `in_progress` flips the abort
  // controller BEFORE the bridge call has had a chance to execute the
  // delivery. The abort kills the Codex subprocess (and with it the
  // MCP tool subprocess) mid-flight — if the bridge HTTP call hasn't
  // gone out yet, delivery never happens. Same shape as the Claude SDK
  // send/end_turn race that PR #122 fixed via PostToolBatch.
  //
  // Status `failed` is already filtered: skip it too. `in_progress` is
  // analytics-only on Codex — we record tool use at completion via the
  // same path, so dropping the in_progress emit costs nothing.
  if (item.status !== "completed") return;
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
