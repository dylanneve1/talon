/**
 * OpenCode main message handler.
 *
 * Orchestrates the full turn lifecycle on top of OpenCode's HTTP API + SSE
 * event stream. Behaviour mirrors the Kilo backend and shares its
 * non-SDK-specific primitives via `../../shared/` and `../../remote-server/`.
 * The OpenCode-specific turn driver + SSE subscription live in `turn.ts`.
 */

import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionId,
  setSessionName,
} from "../../../storage/sessions.js";
import { getChatSettings } from "../../../storage/chat-settings.js";
import { log, logError } from "../../../util/log.js";
import { traceMessage } from "../../../util/trace.js";
import type { QueryParams, QueryResult } from "../../shared/handler-types.js";

import {
  ensureServer,
  ensureSession,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  resolveProviderID,
  parseStoredOpenCodeModelSelection,
  getConfig,
  OPENCODE_SYSTEM_PROMPT_SUFFIX,
} from "../server.js";
import { getOpenCodeTurnSummary } from "../sessions.js";
import {
  createStreamState,
  recordTokens,
  finalizeResponseText,
  formatUserPrompt,
  prepareSystemPrompt,
  extractSessionName,
  summarizeUsage,
  routeDelivery,
  applyRetryDecision,
  recordTurnMetrics,
  recordFailedTurnAccounting,
} from "../../shared/index.js";
import { activeSessions } from "./state.js";
import { runOpenCodeTurn } from "./turn.js";

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  const config = getConfig();
  if (!config) throw new Error("OpenCode agent not initialized");

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

  // Resolve active model + provider lookup against OpenCode's catalog
  const chatSettings = getChatSettings(chatId);
  const activeModel = params.model ?? chatSettings.model ?? config.model;
  const { providerID: selectedProviderID, modelID } =
    parseStoredOpenCodeModelSelection(activeModel);

  const oc = await ensureServer();
  const providerID =
    selectedProviderID ?? (await resolveProviderID(oc, modelID));
  log(
    "agent",
    `[${chatId}] OpenCode model resolved: provider=${providerID} model=${modelID}` +
      (selectedProviderID ? "" : " (provider via catalog lookup)"),
  );
  const sessionId = await ensureSession(oc, chatId);
  await ensureChatMcpServer(oc, chatId);
  await ensurePluginMcpServers(oc, chatId);

  // Build the prompt (time tag + sender + msg_id reference)
  const prompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId,
  });

  // Per-session frozen prompt + OpenCode-specific delivery suffix
  const { text: systemPrompt } = prepareSystemPrompt({
    config,
    previousTurns,
    backendSuffix: OPENCODE_SYSTEM_PROMPT_SUFFIX,
    chatId,
    sessionEpoch: session.createdAt,
  });

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });
  activeSessions.set(chatId, sessionId);

  // Bind the stream state to the chat so token mutators mirror counts
  // into the live-turn overlay — /status updates while the turn runs.
  const state = createStreamState(chatId);
  state.newSessionId = sessionId;
  const promptStartedAt = Date.now();
  const seenQuestionIds = new Set<string>();
  const seenToolCallIds = new Set<string>();

  const setupMs = Date.now() - t0;
  let promptMs = 0;

  try {
    // Drive the OpenCode turn: subscribe to SSE events in parallel with
    // promptAsync, surface tool calls + terminator into shared state, and
    // exit when the turn closes / goes idle. `onStreamDelta` is
    // intentionally NOT forwarded — Telegram's contract is "send the final
    // reply once", not live edit_message updates. Final delivery happens
    // through `end_turn` / `send`.
    const turnStart = Date.now();
    await runOpenCodeTurn({
      oc,
      sessionId,
      prompt,
      systemPrompt,
      providerID,
      modelID,
      state,
      chatId,
      seenQuestionIds,
      seenToolCallIds,
      onStreamDelta: undefined,
      onTextBlock,
      onToolUse,
    });
    promptMs = Date.now() - turnStart;
  } catch (err) {
    const outcome = await applyRetryDecision({
      err,
      chatId,
      activeModel,
      retried: _retried,
      params,
      recurseWithRetried: (p) => handleMessage(p, true),
      backendLabel: "OpenCode",
    });
    if (outcome.retry) return outcome.retry;

    // Terminal failure — account for whatever the turn consumed before
    // dying and drop the live overlay (the retry path above did its own
    // accounting inside the recursive attempt).
    recordFailedTurnAccounting({
      backend: "opencode",
      chatId,
      durationMs: Date.now() - t0,
      toolCalls: state.toolCalls,
      apiCalls: state.numApiCalls,
      model: activeModel,
      usage: {
        inputTokens: state.sdkInputTokens,
        outputTokens: state.sdkOutputTokens,
        cacheRead: state.sdkCacheRead,
        cacheWrite: state.sdkCacheWrite,
      },
      contextTokens: state.contextTokens,
      contextWindow: state.contextWindow,
    });

    logError(
      "agent",
      `[${chatId}] OpenCode error: ${outcome.classified.message}`,
    );
    throw outcome.classified;
  } finally {
    if (activeSessions.get(chatId) === sessionId) {
      activeSessions.delete(chatId);
    }
    // Note: we deliberately do NOT disconnect the chat MCP server here.
    // The server is named per-chat so it's safe to keep across turns;
    // re-spawning the subprocess each turn cost ~800ms per message. The
    // chat-switch disconnect dance (remote-server/mcp.ts) handles
    // visibility scoping when the active chat changes.
  }

  // ── Post-loop accounting ──────────────────────────────────────────────────

  // If the SSE loop missed any usage info, fall back to the session
  // summary endpoint (which always reflects the final server state).
  if (
    state.sdkInputTokens === 0 &&
    state.sdkOutputTokens === 0 &&
    state.sdkCacheRead === 0
  ) {
    try {
      const summary = await getOpenCodeTurnSummary(
        oc,
        sessionId,
        promptStartedAt,
      );
      if (summary.usage.assistantMessages > 0) {
        recordTokens(state, {
          inputTokens: summary.usage.inputTokens,
          outputTokens: summary.usage.outputTokens,
          cacheRead: summary.usage.cacheRead,
          cacheWrite: summary.usage.cacheWrite,
        });
      }
    } catch {
      // best-effort — session summaries can race on cancellation
    }
  }

  const responseText = finalizeResponseText(state);
  const durationMs = Date.now() - t0;
  recordTurnMetrics({
    backend: "opencode",
    durationMs,
    toolCalls: state.toolCalls,
    apiCalls: state.numApiCalls,
    usage: {
      inputTokens: state.sdkInputTokens,
      outputTokens: state.sdkOutputTokens,
      cacheRead: state.sdkCacheRead,
      cacheWrite: state.sdkCacheWrite,
    },
  });

  if (state.newSessionId) {
    const stored = getSession(chatId).sessionId;
    if (stored !== state.newSessionId) {
      setSessionId(chatId, state.newSessionId);
    }
  }

  incrementTurns(chatId);
  recordUsage(chatId, {
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
    durationMs,
    model: activeModel,
  });

  // Set a descriptive session name from the user's first message
  if (previousTurns === 0) {
    const name = extractSessionName(text);
    if (name) setSessionName(chatId, name);
  }

  // ── Delivery — decision tree shared with the Kilo backend ──────────────────
  const delivery = await routeDelivery({
    backendLabel: "OpenCode",
    chatId,
    state,
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
        inputTokens: state.sdkInputTokens,
        outputTokens: state.sdkOutputTokens,
        cacheRead: state.sdkCacheRead,
        cacheWrite: state.sdkCacheWrite,
      },
      { durationMs, toolCalls: state.toolCalls },
    )} terminator=${state.turnTerminated ? "yes" : "no"} ` +
      `delivered=${state.deliveredTextNorms.length} ` +
      `respLen=${responseText.length} ` +
      `setup=${setupMs}ms turn=${promptMs}ms ` +
      `events=${formatEventCounts(state.eventCounts)})`,
  );
  traceMessage(chatId, "out", responseText, {
    durationMs,
    toolCalls: state.toolCalls,
  });

  return {
    text: responseText,
    durationMs,
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
  };
}

/**
 * Compact summary of which SSE event types fired this turn. `none` for a
 * silent turn. Otherwise renders as `delta×42,part.updated×1`.
 */
function formatEventCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries
    .map(([type, n]) => `${type.replace(/^(message|session)\./, "")}×${n}`)
    .join(",");
}
