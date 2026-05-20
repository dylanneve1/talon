/**
 * Agy backend message handler — text-only.
 *
 * Spawns the agy CLI in --print mode per turn and delivers the
 * response as a text-part. No streaming, no tool calls — agy's
 * MCP integration would require writing a per-process MCP config
 * that doesn't collide with the user's regular agy setup at
 * `~/.gemini/config/mcp_config.json` (deferred).
 *
 * What this means in practice: when the agy backend is bound to a
 * chat, the agent can answer questions but can't call `end_turn`,
 * `send`, `react`, or any plugin tools. The handler routes the
 * response via `onTextBlock` (matches the no-tool path in
 * routeDelivery), so users still get replies — they just don't
 * see the rich tool-driven behaviour of the Claude SDK backend.
 */

import type { QueryParams, QueryResult } from "../../core/types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionName,
} from "../../storage/sessions.js";
import { log, logError } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { recordHistogram } from "../../util/metrics.js";
import {
  createStreamState,
  appendText,
  finalizeResponseText,
  formatUserPrompt,
  prepareSystemPrompt,
  extractSessionName,
  routeDelivery,
} from "../shared/index.js";
import { loadConfig } from "../../util/config.js";
import { runAgyPrint, AgyPrintError } from "./spawn.js";
import { AGY_LABEL } from "./constants.js";

export async function handleMessage(params: QueryParams): Promise<QueryResult> {
  const { chatId, text, senderName, isGroup, messageId } = params;
  const session = getSession(chatId);
  const config = loadConfig();
  const turnStarted = Date.now();

  const systemPrompt = prepareSystemPrompt({
    config,
    previousTurns: session.turns,
  });

  const userPrompt = formatUserPrompt({
    text,
    senderName,
    isGroup: isGroup ?? false,
    messageId,
  });

  // Concatenate system + user. agy doesn't expose a system-prompt flag
  // in --print mode, so the system instructions ride inside the prompt
  // body — same shape Talon's other binary backends use as a fallback.
  const prompt =
    systemPrompt.length > 0
      ? `${systemPrompt}\n\n---\n\n${userPrompt}`
      : userPrompt;

  log("agent", `[${chatId}] <- (${text.length} chars, agy)`);

  let responseText = "";
  let stderr = "";
  let exitCode = 0;
  let durationMs = 0;

  try {
    const result = await runAgyPrint({ prompt });
    responseText = result.text;
    stderr = result.stderr;
    exitCode = result.exitCode;
    durationMs = result.durationMs;
  } catch (err) {
    if (err instanceof AgyPrintError) {
      logError(
        "agent",
        `[${chatId}] agy spawn failed (exit=${err.exitCode}): ${err.stderr.slice(0, 200)}`,
      );
      throw new Error(`Agy backend failed: ${err.message}`);
    }
    throw err;
  }

  if (stderr.trim().length > 0) {
    log("agent", `[${chatId}] agy stderr: ${stderr.trim().slice(0, 300)}`);
  }

  const state = createStreamState();
  if (responseText.length > 0) {
    appendText(state, responseText);
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
  if (session.turns === 0 && finalText.length > 0) {
    const name = extractSessionName(finalText);
    if (name) setSessionName(chatId, name);
  }
  recordUsage(chatId, {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });

  recordHistogram("agy.turn_ms", durationMs);

  traceMessage(chatId, "out", finalText, {
    durationMs,
    route: decision.route,
    backend: "agy",
    exitCode,
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
