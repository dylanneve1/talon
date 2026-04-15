/**
 * OpenCode main message handler — orchestrates server, sessions, and models.
 */

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
import {
  ensureServer,
  ensureSession,
  ensureChatMcpServer,
  buildToolOverrides,
  disconnectChatMcpServer,
  resolveProviderID,
  parseStoredOpenCodeModelSelection,
  getConfig,
  OPENCODE_SYSTEM_PROMPT_SUFFIX,
} from "./server.js";
import {
  extractPartsSummary,
  extractAssistantUsage,
  waitForPromptWithQuestionGuard,
  waitForAssistantReply,
  getOpenCodeTurnSummary,
  type OpenCodeAssistantInfo,
} from "./sessions.js";

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  const config = getConfig();
  if (!config) throw new Error("OpenCode agent not initialized");

  const { chatId, text, senderName, isGroup, onTextBlock } = params;
  const t0 = Date.now();
  const previousTurns = getSession(chatId).turns;

  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.model;
  const { providerID: selectedProviderID, modelID } =
    parseStoredOpenCodeModelSelection(activeModel);

  const oc = await ensureServer();
  const providerID =
    selectedProviderID ?? (await resolveProviderID(oc, modelID));
  const sessionId = await ensureSession(oc, chatId);
  const chatMcpServerName = await ensureChatMcpServer(oc, chatId);
  const toolOverrides = await buildToolOverrides(oc, chatMcpServerName);
  const seenQuestionIds = new Set<string>();

  const msgIdHint = params.messageId ? ` [msg_id:${params.messageId}]` : "";
  const prompt = isGroup
    ? `[${senderName}]${msgIdHint}: ${text}`
    : `${text}${msgIdHint}`;

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  try {
    const promptStartedAt = Date.now();
    const resp = await waitForPromptWithQuestionGuard(
      oc,
      {
        sessionID: sessionId,
        parts: [{ type: "text", text: prompt }],
        model: { providerID, modelID },
        system: config.systemPrompt + OPENCODE_SYSTEM_PROMPT_SUFFIX,
        ...(toolOverrides ? { tools: toolOverrides } : {}),
      },
      chatId,
      seenQuestionIds,
    );

    const data = resp.data as Record<string, unknown> | undefined;
    const parts = Array.isArray(data?.parts)
      ? (data.parts as Array<Record<string, unknown>>)
      : [];
    let assistantInfo =
      data?.info && typeof data.info === "object"
        ? (data.info as OpenCodeAssistantInfo)
        : undefined;

    let { text: responseText, toolCalls } = extractPartsSummary(parts);

    if (!responseText) {
      const fallbackReply = await waitForAssistantReply(
        oc,
        sessionId,
        promptStartedAt,
        chatId,
        seenQuestionIds,
      );
      responseText = fallbackReply.text;
      toolCalls = Math.max(toolCalls, fallbackReply.toolCalls);
      assistantInfo = fallbackReply.info ?? assistantInfo;
    }

    const turnSummary = await getOpenCodeTurnSummary(
      oc,
      sessionId,
      promptStartedAt,
    );
    const fallbackUsage = extractAssistantUsage(assistantInfo);
    const usage =
      turnSummary.usage.assistantMessages > 0
        ? {
            inputTokens: turnSummary.usage.inputTokens,
            outputTokens: turnSummary.usage.outputTokens,
            cacheRead: turnSummary.usage.cacheRead,
            cacheWrite: turnSummary.usage.cacheWrite,
            costUsd: turnSummary.usage.costUsd,
            providerID:
              turnSummary.latestAssistant?.info?.providerID ??
              fallbackUsage.providerID,
            modelID:
              turnSummary.latestAssistant?.info?.modelID ??
              fallbackUsage.modelID,
          }
        : fallbackUsage;

    if (!responseText) {
      logWarn(
        "agent",
        `[${chatId}] OpenCode returned no assistant text for ${providerID}/${modelID}`,
      );
      responseText =
        "Sorry \u2014 I got an empty response from OpenCode. Please try again.";
    }

    if (responseText && onTextBlock) {
      await onTextBlock(responseText);
    }

    const durationMs = Date.now() - t0;

    incrementTurns(chatId);
    recordUsage(chatId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      durationMs,
      model: usage.modelID ?? activeModel,
      costUsd: usage.costUsd,
    });

    if (previousTurns === 0 && text) {
      const cleanText = text
        .replace(/^\[.*?\]\s*/g, "")
        .replace(/\[msg_id:\d+\]\s*/g, "")
        .trim();
      if (cleanText) {
        setSessionName(
          chatId,
          cleanText.length > 30 ? cleanText.slice(0, 30) + "..." : cleanText,
        );
      }
    }

    log(
      "agent",
      `[${chatId}] -> (${durationMs}ms${toolCalls > 0 ? ` tools=${toolCalls}` : ""})`,
    );
    traceMessage(chatId, "out", responseText, { durationMs, toolCalls });

    return {
      text: responseText.trim(),
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    };
  } catch (err) {
    const classified = classify(err);
    if (classified.reason === "session_expired" && !_retried) {
      logWarn("agent", `[${chatId}] OpenCode session expired, retrying`);
      resetSession(chatId);
      return handleMessage(params, true);
    }
    logError("agent", `[${chatId}] OpenCode error: ${classified.message}`);
    throw classified;
  } finally {
    await disconnectChatMcpServer(oc, chatMcpServerName);
  }
}
