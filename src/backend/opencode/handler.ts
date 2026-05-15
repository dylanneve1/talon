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
import { getChatSettings, setChatModel } from "../../storage/chat-settings.js";
import { classify } from "../../core/errors.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import {
  ensureServer,
  ensureSession,
  ensureChatMcpServer,
  ensurePluginMcpServers,
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
import {
  formatUserPrompt,
  prepareSystemPrompt,
  extractSessionName,
  classifyRetry,
  summarizeUsage,
} from "../shared/index.js";

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
  await ensurePluginMcpServers(oc, chatId);
  const toolOverrides = await buildToolOverrides(oc, chatMcpServerName);
  const seenQuestionIds = new Set<string>();

  // First-turn system-prompt rebuild + backend suffix. The OpenCode
  // delivery suffix tells the model to reply as plain text.
  const systemPrompt = prepareSystemPrompt({
    config,
    previousTurns,
    backendSuffix: OPENCODE_SYSTEM_PROMPT_SUFFIX,
  });

  const prompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId: params.messageId,
  });

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
        system: systemPrompt,
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
      const name = extractSessionName(text);
      if (name) setSessionName(chatId, name);
    }

    log(
      "agent",
      `[${chatId}] -> (${summarizeUsage(
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        },
        { durationMs, toolCalls },
      )})`,
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

    const decision = classifyRetry({
      error: classified,
      activeModel,
      retried: _retried,
    });

    if (decision.kind === "reset_and_retry") {
      logWarn(
        "agent",
        `[${chatId}] OpenCode ${decision.reason}, resetting session and retrying`,
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

    logError("agent", `[${chatId}] OpenCode error: ${classified.message}`);
    throw classified;
  } finally {
    await disconnectChatMcpServer(oc, chatMcpServerName);
  }
}
