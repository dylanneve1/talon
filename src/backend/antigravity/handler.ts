/**
 * Antigravity backend message handler.
 *
 * Owns the one-turn lifecycle against the Python bridge subprocess.
 * Shares prompt-formatting, system-prompt rebuild, session bookkeeping,
 * and delivery routing with the other backends via `../shared/`.
 *
 * Why this handler is shorter than Claude SDK / Codex / openai-agents:
 *
 *   - The Python bridge handles model streaming + tool-call dispatch
 *     internally (Antigravity's `Agent.chat()` returns a fully
 *     resolvable async iterator). By the time `bridge.chat()` resolves,
 *     the model loop has closed. No SDK-level event translation lives
 *     here — that work is in `agent_bridge.py`.
 *   - Tool calls reach Talon via MCP (the bridge spawned our
 *     `telegram-tools` MCP server as part of its mcp_servers list).
 *     `end_turn` / `send` / `react` are MCP calls that hit Talon's
 *     gateway — Talon delivers the reply through that path. The TS
 *     handler observes them via the `onToolCall` callback for logging
 *     and `onToolUse` propagation.
 *   - No SDK-level fallback ladder. If Antigravity raises (e.g. quota
 *     exceeded, model not available), we surface it cleanly via
 *     `routeDelivery` so the user sees a useful error rather than a
 *     stack trace. Future iterations can add the shared
 *     `applyRetryDecision` ladder once we see real failure modes in
 *     prod.
 */

import type { QueryParams, QueryResult } from "../../core/types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionName,
} from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { log, logError } from "../../util/log.js";
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
} from "../shared/index.js";

import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_SYSTEM_PROMPT_SUFFIX,
} from "./constants.js";
import { getState } from "./state.js";
import { ensureBridge } from "./init.js";

// ── Active abort registry ───────────────────────────────────────────────────

const activeAborts = new Map<string, AbortController>();

export function getActiveAbort(chatId: string): AbortController | undefined {
  return activeAborts.get(chatId);
}

// ── Local utility ───────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

let nextTurnSeq = 0;

function nextTurnId(chatId: string): string {
  nextTurnSeq = (nextTurnSeq + 1) | 0;
  return `t-${Date.now().toString(36)}-${nextTurnSeq.toString(36)}-${chatId.slice(-6)}`;
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleMessage(params: QueryParams): Promise<QueryResult> {
  const state = getState();
  if (!state.config) {
    throw new Error("Antigravity backend not initialized");
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

  const chatSettings = getChatSettings(chatId);
  const activeModel =
    chatSettings.model ?? state.config.model ?? ANTIGRAVITY_DEFAULT_MODEL;
  log("agent", `[${chatId}] Antigravity model resolved: ${activeModel}`);

  const systemPrompt = prepareSystemPrompt({
    config: state.config,
    previousTurns,
    backendSuffix: ANTIGRAVITY_SYSTEM_PROMPT_SUFFIX,
  });

  const userPrompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId,
  });

  // The bridge keeps a single agent context per chat with system
  // instructions baked at start. On the first turn we prepend the
  // freshly-built systemPrompt so the agent sees it; subsequent turns
  // continue the conversation. (Antigravity's `Agent.chat()` carries
  // a multi-turn history internally.)
  const isFirstTurn = previousTurns === 0;
  const promptForBridge = isFirstTurn
    ? `${systemPrompt}\n\n---\n\n${userPrompt}`
    : userPrompt;

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  const abortController = new AbortController();
  activeAborts.set(chatId, abortController);

  const streamState = createStreamState();
  const seenToolCallIds = new Set<string>();
  let terminatorFired = false;

  let bridge;
  try {
    // Pass the per-chat model so `ensureBridge` builds the agent
    // config against the user's selection (e.g. gemini-2.5-flash-lite)
    // rather than the chat-role's global default — that default
    // routinely points at a non-Gemini model (claude-opus-4-7 today)
    // and the bridge would 404 on the first Gemini API call.
    bridge = await ensureBridge(chatId, activeModel);
  } catch (err) {
    activeAborts.delete(chatId);
    const msg = errMsg(err);
    logError("agent", `[${chatId}] Antigravity bridge start failed: ${msg}`);
    // Surface a clean error message rather than a raw exception.
    if (onTextBlock) {
      await onTextBlock(
        `Antigravity backend failed to start: ${msg}\n\nCheck that google-antigravity is installed in the configured venv and GEMINI_API_KEY is set.`,
      );
    }
    throw err;
  }

  const turnId = nextTurnId(chatId);
  const onAbort = () => {
    bridge?.abort(turnId);
  };
  abortController.signal.addEventListener("abort", onAbort);

  try {
    const turnStart = Date.now();

    const result = await bridge.chat({
      id: turnId,
      prompt: promptForBridge,
      onText: (delta) => {
        if (!delta) return;
        // Mirror the shared accumulator the other backends use so
        // routeDelivery + finalizeResponseText work the same way.
        streamState.currentBlockText += delta;
        streamState.lastTrailingText += delta;
        if (params.onStreamDelta) {
          params.onStreamDelta(
            streamState.allResponseText + streamState.currentBlockText,
            "text",
          );
        }
      },
      onThought: (delta) => {
        if (params.onStreamDelta && delta) {
          params.onStreamDelta(delta, "thinking");
        }
      },
      onToolCall: (name, args) => {
        const stripped = stripMcpPrefix(name);
        const toolKey = `${name}:${JSON.stringify(args).slice(0, 200)}`;
        if (seenToolCallIds.has(toolKey)) return;
        seenToolCallIds.add(toolKey);
        recordToolUse(streamState, stripped, args);
        if (onToolUse) onToolUse(stripped, args);
        if (isTurnTerminator(stripped) && !terminatorFired) {
          terminatorFired = true;
          // MCP-side delivery has already happened. Tell the bridge
          // to abort the model loop now — Gemini will otherwise
          // happily keep generating and call `end_turn` (or `send`)
          // again, producing duplicate replies. `bridge.abort()`
          // cancels the in-flight asyncio task on the Python side;
          // `bridge.chat()` resolves shortly after with whatever was
          // accumulated so far. The `!terminatorFired` guard means
          // we only ever abort once per turn even if the model
          // races multiple terminators back-to-back.
          bridge?.abort(turnId);
        }
      },
    });

    const turnEnd = Date.now();
    const turnMs = turnEnd - turnStart;

    // Surface usage to Talon's session bookkeeping.
    const usage = result.usage ?? null;
    const promptTokens = usage?.prompt_token_count ?? 0;
    const cached = usage?.cached_content_token_count ?? 0;
    const completion = usage?.candidates_token_count ?? 0;
    recordTokens(streamState, {
      inputTokens: promptTokens,
      outputTokens: completion,
      cacheRead: cached,
      cacheWrite: 0,
    });

    if (isFirstTurn && text) {
      const sessionName = extractSessionName(text);
      if (sessionName) setSessionName(chatId, sessionName);
    }
    incrementTurns(chatId);
    recordUsage(chatId, {
      inputTokens: promptTokens,
      outputTokens: completion,
      cacheRead: cached,
      cacheWrite: 0,
      durationMs: turnMs,
      model: activeModel,
    });

    incrementCounter("backend.antigravity.turn");
    recordHistogram("backend.antigravity.turn_ms", turnMs);

    // Decide what to deliver. The agent has three delivery routes:
    //   1) Terminator tool fired (`end_turn`/`send`/`react`) — Talon
    //      already delivered via MCP; we don't deliver text again.
    //   2) The agent emitted plain text — deliver it via onTextBlock.
    //   3) Empty stream — silent close.
    if (terminatorFired) {
      // Pre-mark so routeDelivery treats this as a bridge delivery.
      streamState.hadBridgeDelivery = true;
    }
    const responseText = finalizeResponseText(streamState);

    const decision = await routeDelivery({
      backendLabel: "Antigravity",
      chatId,
      state: streamState,
      responseText,
      onTextBlock,
    });

    log(
      "agent",
      `[${chatId}] -> route=${decision.route} text=${responseText.length} ` +
        `tools=${streamState.toolCalls} term=${terminatorFired} ` +
        summarizeUsage({
          inputTokens: promptTokens,
          outputTokens: completion,
          cacheRead: cached,
          cacheWrite: 0,
        }),
    );

    if (responseText) {
      traceMessage(chatId, "out", responseText, {});
    }

    const durationMs = Date.now() - t0;
    return {
      text: responseText,
      durationMs,
      inputTokens: promptTokens,
      outputTokens: completion,
      cacheRead: cached,
      cacheWrite: 0,
    };
  } catch (err) {
    const msg = errMsg(err);
    logError("agent", `[${chatId}] Antigravity turn failed: ${msg}`);
    incrementCounter("backend.antigravity.turn_failed");
    if (onTextBlock) {
      await onTextBlock(`Antigravity turn failed: ${msg}`);
    }
    throw err;
  } finally {
    abortController.signal.removeEventListener("abort", onAbort);
    activeAborts.delete(chatId);
  }
}
