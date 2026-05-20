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
} from "../shared/index.js";
import { runAgyPrint, AgyPrintError } from "./spawn.js";
import { AGY_LABEL } from "./constants.js";
import {
  getConversation,
  setConversation,
  forgetConversation,
} from "./state.js";

/**
 * Serialises first-turn (no-conversation-id) spawns so two chats
 * starting agy concurrently don't both observe the same "newest .pb"
 * after one of them lands. Resume turns (with id) bypass the lock —
 * they don't need to learn anything from the conversations dir.
 *
 * Implementation: a tiny single-slot lock built on Promise chaining.
 * Cheaper than pulling in async-mutex for one call site.
 */
let firstTurnLock: Promise<void> = Promise.resolve();
async function withFirstTurnLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = firstTurnLock;
  let release!: () => void;
  firstTurnLock = new Promise<void>((r) => {
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
    const run = () =>
      runAgyPrint({
        prompt: userPrompt,
        conversationId: existingConversation,
        signal: undefined,
      });
    // First turn for this chat needs the snapshot-diff lock so two
    // chats starting concurrently don't both claim the same new .pb.
    result = existingConversation ? await run() : await withFirstTurnLock(run);
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
    log("agent", `[${chatId}] agy stderr: ${result.stderr.trim().slice(0, 300)}`);
  }

  // Persist the conversation id for the next turn. On first turn the
  // spawn captured it from the `.pb` diff; on resume turns it's
  // unchanged.
  if (result.conversationId) {
    setConversation(chatId, result.conversationId);
  }

  const state = createStreamState();
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
  // agy --print doesn't expose token counts on stdout; record the
  // turn for bookkeeping but leave the token fields at 0.
  recordUsage(chatId, {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    durationMs: result.durationMs,
    model: "agy",
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
