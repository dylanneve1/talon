/**
 * Agy backend message handler.
 *
 * Each turn shells out to the local `agy` CLI; agy is locally
 * OAuth-authenticated (no API key needed) and brings its own
 * persona/system instructions. We don't stack Talon's system prompt
 * on top — that fights agy's baked-in instructions and tanks output
 * quality. Per-chat conversational continuity is threaded via agy's
 * own `--conversation <uuid>` flag (see `state.ts` and `spawn.ts`).
 *
 * Limitations (still):
 *
 *   - **No streaming.** `agy --print` returns the full response on
 *     close — we report it once via `onTextBlock`.
 *   - **No tool calls.** agy's MCP tools (`~/.gemini/config/mcp_config.json`)
 *     work on the agy side, but the call-events don't surface in
 *     stdout in a structured way we can route. Talon's frontend
 *     delivery tools (`end_turn` / `send` / `react`) aren't reachable
 *     either. Tool integration is deferred.
 */

import type { QueryParams, QueryResult } from "../../core/types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionName,
  resetSession,
} from "../../storage/sessions.js";
import { log, logError } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { recordHistogram, incrementCounter } from "../../util/metrics.js";
import {
  createStreamState,
  appendText,
  finalizeResponseText,
  formatUserPrompt,
  extractSessionName,
  routeDelivery,
  recordToolUse,
} from "../shared/index.js";
import { runAgyPrint, AgyPrintError } from "./spawn.js";
import { AGY_LABEL } from "./constants.js";
import {
  getConversation,
  setConversation,
  forgetConversation,
} from "./state.js";
import { installMcpConfigForChat } from "./mcp-config.js";
import { getAgyMcpContext } from "./factory-context.js";

/**
 * Process-wide serial lock around the agy spawn. Two reasons:
 *
 *   1. First-turn (no conversation id) spawns need the `.pb` directory
 *      snapshot-diff to learn the new id — concurrent first-turns
 *      could both observe the same `newest .pb` and one would steal
 *      the other's conversation.
 *   2. agy's MCP config lives at a single global path
 *      `~/.gemini/config/mcp_config.json`. We re-stamp it with the
 *      current chat's `TALON_CHAT_ID` env right before each spawn so
 *      MCP tools route back to the correct chat. Two parallel chats
 *      would race on the file.
 *
 * Implementation: single-slot promise chain; cheaper than pulling in
 * a mutex library for one call site.
 */
let agySpawnLock: Promise<void> = Promise.resolve();
async function withAgySpawnLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = agySpawnLock;
  let release!: () => void;
  agySpawnLock = new Promise<void>((r) => {
    release = r;
  });
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

export async function handleMessage(params: QueryParams): Promise<QueryResult> {
  const { chatId, text, senderName, isGroup, messageId } = params;
  const session = getSession(chatId);
  const turnStarted = Date.now();

  const userPrompt = formatUserPrompt({
    text,
    senderName,
    isGroup: isGroup ?? false,
    messageId,
  });

  const existingConversation = getConversation(chatId);
  const turnNumber = session.turns;

  log(
    "agent",
    `[${chatId}] agy <- (${text.length} chars, turn=${turnNumber}, conv=${
      existingConversation ? existingConversation.slice(0, 8) + "…" : "(new)"
    })`,
  );
  traceMessage(chatId, "in", text, { senderName, isGroup });

  let result;
  try {
    // Always take the global lock — install per-chat MCP config,
    // snapshot conversations dir, spawn, release. Two chats can't
    // race on the global `mcp_config.json` and the .pb snapshot diff
    // stays accurate.
    result = await withAgySpawnLock(async () => {
      const mcpCtx = getAgyMcpContext();
      if (mcpCtx) {
        try {
          installMcpConfigForChat({
            chatId,
            bridgeUrl: `http://127.0.0.1:${mcpCtx.getBridgePort()}`,
            frontends: mcpCtx.frontends,
            braveApiKey: mcpCtx.braveApiKey,
          });
        } catch (err) {
          logError(
            "agent",
            `[${chatId}] agy: MCP config install failed (continuing without tools)`,
            err,
          );
        }
      }
      return runAgyPrint({
        prompt: userPrompt,
        conversationId: existingConversation,
        signal: undefined,
      });
    });
  } catch (err) {
    if (err instanceof AgyPrintError) {
      const detail = err.stderr.trim().slice(0, 300);
      logError(
        "agent",
        `[${chatId}] agy spawn failed (exit=${err.exitCode}): ${detail}`,
      );
      // Stale conversation id is recoverable: agy logs `conversation
      // "<uuid>" not found` to stdout (not stderr) but exits 0 with
      // the warning + a fresh-context reply. If we see a more permanent
      // failure (exit != 0), drop the stored id so the next turn
      // starts fresh.
      if (existingConversation && err.exitCode !== 0) {
        forgetConversation(chatId);
        log(
          "agent",
          `[${chatId}] agy: dropped stale conversation id after error`,
        );
      }
      throw new Error(`agy backend failed: ${err.message}`);
    }
    throw err;
  }

  if (result.stderr.trim().length > 0) {
    log(
      "agent",
      `[${chatId}] agy stderr: ${result.stderr.trim().slice(0, 300)}`,
    );
  }

  // `result.text` already comes from the structured `transcript.jsonl`
  // (latest `PLANNER_RESPONSE/MODEL` entry) when the conversation
  // exists, so no diffing math is needed here. Persist the
  // conversation id for the next turn.
  if (result.conversationId) {
    setConversation(chatId, result.conversationId);
  }

  const state = createStreamState();
  // Replay each tool call agy made during the turn through the shared
  // `recordToolUse` so the bridge-delivery / turn-terminator semantics
  // are correctly reflected on the stream state. The handler is
  // post-hoc (transcript-parsed, not stream-of-events) so we don't
  // see them live, but for `routeDelivery`'s decision tree only the
  // final tally matters.
  for (const tc of result.toolCalls) {
    recordToolUse(state, tc.name, tc.input);
  }
  if (result.text.length > 0) {
    appendText(state, result.text);
  }
  const finalText = finalizeResponseText(state);

  const decision = await routeDelivery({
    backendLabel: AGY_LABEL,
    chatId,
    state,
    responseText: finalText,
    onTextBlock: params.onTextBlock,
  });

  incrementTurns(chatId);
  if (turnNumber === 0 && finalText.length > 0) {
    const name = extractSessionName(finalText);
    if (name) setSessionName(chatId, name);
  }
  // Real token counts pulled from agy's internal language server
  // mid-spawn — see `usage.ts` for the protocol. Fall back to a
  // char/4 estimate when the LS poller missed (LS unreachable, turn
  // errored before any model step landed, conversation id only
  // resolved post-spawn for first turns).
  let inputTokens: number;
  let outputTokens: number;
  let cacheRead: number;
  let usageModel: string;
  if (result.usage) {
    inputTokens = result.usage.inputTokens;
    outputTokens =
      result.usage.outputTokens + result.usage.thinkingTokens;
    cacheRead = result.usage.cacheReadTokens;
    usageModel = result.usage.model;
    log(
      "agent",
      `[${chatId}] agy usage: in=${inputTokens} out=${outputTokens} ` +
        `cache=${cacheRead} model=${usageModel} ` +
        `(${result.usage.callCount} API call${
          result.usage.callCount === 1 ? "" : "s"
        }, maxStep=${result.usage.maxStepIndex})`,
    );
  } else {
    inputTokens = Math.ceil(userPrompt.length / 4);
    outputTokens = Math.ceil(finalText.length / 4);
    cacheRead = 0;
    usageModel = "agy";
    log(
      "agent",
      `[${chatId}] agy: real usage unavailable, using char/4 estimate ` +
        `(in≈${inputTokens} out≈${outputTokens})`,
    );
  }
  // Context window comes from agy's model catalog via `GetAvailableModels`
  // when available — see `fetchModelInfo` in usage.ts. The placeholder is
  // 1M which matches every current Gemini-3 / Gemini-2.5 model agy lists
  // (claude-opus would be 250k but agy doesn't ship it through `agy --print`).
  const contextWindow = result.modelInfo?.contextWindow ?? 1_048_576;
  recordUsage(chatId, {
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite: 0,
    durationMs: result.durationMs,
    model: usageModel,
    // `inputTokens` already includes the cached portion (agy reports
    // `inputTokens=32k, cacheReadTokens=16k` meaning of those 32k,
    // 16k were cache hits — not a separate 16k on top). Don't
    // double-count by adding cacheRead.
    contextTokens: inputTokens + outputTokens,
    contextWindow,
  });

  incrementCounter("agy.turn");
  recordHistogram("agy.turn_ms", result.durationMs);

  traceMessage(chatId, "out", finalText, {
    durationMs: result.durationMs,
    route: decision.route,
    backend: "agy",
    exitCode: result.exitCode,
    conversation: result.conversationId,
  });

  return {
    text: finalText,
    durationMs: Date.now() - turnStarted,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

/**
 * Talon's `/reset` calls this to drop per-chat memory. For agy that
 * means forgetting the conversation id so the next turn starts a
 * fresh agy conversation. `resetSession` clears the bot-side session
 * (turn count, name) for the same chat in lockstep.
 */
export function resetChat(chatId: string): void {
  forgetConversation(chatId);
  resetSession(chatId);
  log("agent", `[${chatId}] agy: reset (conversation forgotten)`);
}
