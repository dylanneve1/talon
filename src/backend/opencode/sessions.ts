/**
 * OpenCode session helpers — message parsing, usage summarization,
 * snapshot retrieval, and the question-rejection guard used during prompts.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { logWarn } from "../../util/log.js";
import { ensureServer } from "./server.js";

// ---------------------------------------------------------------------------
// Local utility
// ---------------------------------------------------------------------------

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OPENCODE_SESSION_MESSAGE_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenCodeAssistantInfo = {
  role?: string;
  finish?: string;
  time?: {
    created?: number;
    completed?: number;
  };
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  providerID?: string;
  modelID?: string;
};

type OpenCodeSessionSnapshot = {
  sessionId: string;
  createdAt?: number;
  updatedAt?: number;
  assistant?: {
    providerID?: string;
    modelID?: string;
    createdAt?: number;
    completedAt?: number;
    costUsd: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
  usage?: {
    assistantMessages: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
    totalCacheRead: number;
    totalCacheWrite: number;
    totalCostUsd: number;
  };
};

type ParsedAssistantMessage = {
  createdAt: number;
  info?: OpenCodeAssistantInfo;
  parts: Array<Record<string, unknown>>;
};

type OpenCodeUsageSummary = {
  assistantMessages: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export function extractPartsSummary(parts: Array<Record<string, unknown>>): {
  text: string;
  toolCalls: number;
} {
  const textParts: string[] = [];
  let toolCalls = 0;

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
    } else if (part.type === "tool") {
      toolCalls++;
    }
  }

  return {
    text: textParts.join("\n\n").trim(),
    toolCalls,
  };
}

export function extractAssistantUsage(
  info: OpenCodeAssistantInfo | undefined,
): {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  providerID?: string;
  modelID?: string;
} {
  return {
    inputTokens: info?.tokens?.input ?? 0,
    outputTokens: info?.tokens?.output ?? 0,
    cacheRead: info?.tokens?.cache?.read ?? 0,
    cacheWrite: info?.tokens?.cache?.write ?? 0,
    costUsd: info?.cost ?? 0,
    providerID: info?.providerID,
    modelID: info?.modelID,
  };
}

function hasAssistantUsage(info: OpenCodeAssistantInfo | undefined): boolean {
  return Boolean(
    info?.tokens?.input ||
    info?.tokens?.output ||
    info?.tokens?.reasoning ||
    info?.tokens?.cache?.read ||
    info?.tokens?.cache?.write ||
    info?.cost,
  );
}

function createEmptyUsageSummary(): OpenCodeUsageSummary {
  return {
    assistantMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
  };
}

function parseAssistantMessage(
  message: unknown,
): ParsedAssistantMessage | null {
  if (!message || typeof message !== "object") return null;

  const data = message as {
    info?: OpenCodeAssistantInfo;
    parts?: Array<Record<string, unknown>>;
  };

  if (data.info?.role !== "assistant") return null;

  return {
    createdAt: data.info?.time?.created ?? 0,
    info: data.info,
    parts: Array.isArray(data.parts) ? data.parts : [],
  };
}

function isMeaningfulAssistantMessage(
  message: ParsedAssistantMessage,
): boolean {
  return Boolean(
    message.parts.length > 0 ||
    message.info?.time?.completed ||
    hasAssistantUsage(message.info),
  );
}

export function summarizeOpenCodeAssistantMessages(
  messages: Array<unknown>,
  minCreatedAt = 0,
): {
  latestAssistant?: ParsedAssistantMessage;
  usage: OpenCodeUsageSummary;
} {
  const usage = createEmptyUsageSummary();
  const assistants = messages
    .map((message) => parseAssistantMessage(message))
    .filter((message): message is ParsedAssistantMessage => Boolean(message))
    .filter(
      (message) =>
        message.createdAt >= minCreatedAt &&
        isMeaningfulAssistantMessage(message),
    );

  for (const assistant of assistants) {
    const assistantUsage = extractAssistantUsage(assistant.info);
    usage.assistantMessages += 1;
    usage.inputTokens += assistantUsage.inputTokens;
    usage.outputTokens += assistantUsage.outputTokens;
    usage.reasoningTokens += assistant.info?.tokens?.reasoning ?? 0;
    usage.cacheRead += assistantUsage.cacheRead;
    usage.cacheWrite += assistantUsage.cacheWrite;
    usage.costUsd += assistantUsage.costUsd;
  }

  const latestAssistant = assistants.sort(
    (left, right) => right.createdAt - left.createdAt,
  )[0];

  return { latestAssistant, usage };
}

async function listSessionMessages(
  oc: OpencodeClient,
  sessionId: string,
  limit = OPENCODE_SESSION_MESSAGE_LIMIT,
): Promise<Array<unknown>> {
  const resp = await oc.session.messages({
    sessionID: sessionId,
    limit,
  });
  const page = Array.isArray(resp.data) ? resp.data : [];
  const messages: Array<unknown> = [];
  const seenMessageIds = new Set<string>();

  for (const message of page) {
    const messageId = (message as Record<string, any>)?.info?.id as
      | string
      | undefined;
    if (messageId && seenMessageIds.has(messageId)) continue;
    if (messageId) seenMessageIds.add(messageId);
    messages.push(message);
  }

  return messages;
}

export async function getOpenCodeTurnSummary(
  oc: OpencodeClient,
  sessionId: string,
  minCreatedAt: number,
): Promise<{
  latestAssistant?: ParsedAssistantMessage;
  usage: OpenCodeUsageSummary;
}> {
  const messages = await listSessionMessages(oc, sessionId);
  return summarizeOpenCodeAssistantMessages(messages, minCreatedAt);
}

export async function getOpenCodeSessionSnapshot(
  sessionId: string,
): Promise<OpenCodeSessionSnapshot | undefined> {
  if (!sessionId) return undefined;

  const oc = await ensureServer();
  const [sessionResp, messages] = await Promise.all([
    oc.session.get({ sessionID: sessionId }),
    listSessionMessages(oc, sessionId),
  ]);

  const sessionInfo =
    (sessionResp.data as
      | {
          time?: {
            created?: number;
            updated?: number;
          };
        }
      | undefined) ?? {};
  const summary = summarizeOpenCodeAssistantMessages(messages);
  const latestAssistant = summary.latestAssistant;
  const usage = extractAssistantUsage(latestAssistant?.info);

  return {
    sessionId,
    createdAt: sessionInfo.time?.created,
    updatedAt: sessionInfo.time?.updated,
    assistant: latestAssistant
      ? {
          providerID: usage.providerID,
          modelID: usage.modelID,
          createdAt: latestAssistant.info?.time?.created,
          completedAt: latestAssistant.info?.time?.completed,
          costUsd: usage.costUsd,
          totalTokens: latestAssistant.info?.tokens?.total ?? 0,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: latestAssistant.info?.tokens?.reasoning ?? 0,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        }
      : undefined,
    usage: {
      assistantMessages: summary.usage.assistantMessages,
      totalInputTokens: summary.usage.inputTokens,
      totalOutputTokens: summary.usage.outputTokens,
      totalReasoningTokens: summary.usage.reasoningTokens,
      totalCacheRead: summary.usage.cacheRead,
      totalCacheWrite: summary.usage.cacheWrite,
      totalCostUsd: summary.usage.costUsd,
    },
  };
}

function summarizeQuestionHeaders(
  questions: Array<Record<string, unknown>>,
): string {
  return questions
    .map((question) => {
      if (typeof question.header === "string" && question.header.trim()) {
        return question.header.trim();
      }

      if (typeof question.question === "string" && question.question.trim()) {
        return question.question.trim();
      }

      return null;
    })
    .filter((value): value is string => Boolean(value))
    .join(" | ");
}

async function rejectPendingQuestions(
  oc: OpencodeClient,
  sessionId: string,
  chatId: string,
  seenQuestionIds: Set<string>,
): Promise<void> {
  const questionsResp = await oc.question.list();
  const pendingQuestions = Array.isArray(questionsResp.data)
    ? questionsResp.data
    : [];

  for (const request of pendingQuestions) {
    if (!request || typeof request !== "object") continue;

    const data = request as {
      id?: string;
      sessionID?: string;
      questions?: Array<Record<string, unknown>>;
    };

    const requestId = data.id;
    if (!requestId || data.sessionID !== sessionId) continue;
    if (seenQuestionIds.has(requestId)) continue;

    seenQuestionIds.add(requestId);
    const questions = Array.isArray(data.questions) ? data.questions : [];
    const summary = summarizeQuestionHeaders(questions);

    logWarn(
      "agent",
      `[${chatId}] Rejecting OpenCode question ${requestId}${summary ? `: ${summary}` : ""}`,
    );

    try {
      await oc.question.reject({ requestID: requestId });
    } catch (err) {
      logWarn(
        "agent",
        `[${chatId}] Failed to reject OpenCode question ${requestId}: ${errMsg(err)}`,
      );
    }
  }
}

export async function waitForPromptWithQuestionGuard(
  oc: OpencodeClient,
  parameters: Parameters<OpencodeClient["session"]["prompt"]>[0],
  chatId: string,
  seenQuestionIds: Set<string>,
) {
  let finished = false;

  const watchdog = (async () => {
    while (!finished) {
      try {
        await rejectPendingQuestions(
          oc,
          parameters.sessionID,
          chatId,
          seenQuestionIds,
        );
      } catch (err) {
        logWarn(
          "agent",
          `[${chatId}] Failed while polling OpenCode questions: ${errMsg(err)}`,
        );
      }

      if (!finished) {
        await sleep(350);
      }
    }
  })();

  try {
    return await oc.session.prompt(parameters);
  } finally {
    finished = true;
    await watchdog;
    await rejectPendingQuestions(
      oc,
      parameters.sessionID,
      chatId,
      seenQuestionIds,
    );
  }
}

export async function waitForAssistantReply(
  oc: OpencodeClient,
  sessionId: string,
  minCreatedAt: number,
  chatId: string,
  seenQuestionIds: Set<string>,
): Promise<{
  text: string;
  toolCalls: number;
  info?: OpenCodeAssistantInfo;
}> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    await rejectPendingQuestions(oc, sessionId, chatId, seenQuestionIds);

    const messagesResp = await oc.session.messages({
      sessionID: sessionId,
      limit: 20,
    });
    const messages = Array.isArray(messagesResp.data) ? messagesResp.data : [];

    const assistantMessages = messages
      .map((message) => parseAssistantMessage(message))
      .filter((message): message is ParsedAssistantMessage => Boolean(message))
      .sort((left, right) => right.createdAt - left.createdAt);

    for (const message of assistantMessages) {
      if (message.createdAt < minCreatedAt) continue;

      const summary = extractPartsSummary(message.parts);
      if (summary.text || summary.toolCalls > 0) {
        return {
          ...summary,
          info: message.info,
        };
      }
    }

    await sleep(500);
  }

  return { text: "", toolCalls: 0 };
}
