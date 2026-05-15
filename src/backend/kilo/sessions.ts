/**
 * Kilo session helpers — message parsing, usage summarization, snapshot
 * retrieval, and the pending-question rejection guard used during prompts.
 *
 * Kilo organises a session as an ordered list of `messages`, each with a
 * typed parts array (text / tool / reasoning / step-start / step-finish).
 * Helpers in this module translate that shape into the shared
 * stream-state primitives + a usage summary suitable for Talon's
 * accounting layer.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { KiloClient } from "@kilocode/sdk/v2";
import { logWarn } from "../../util/log.js";
import { ensureServer } from "./server.js";

// ── Local utility ───────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// ── Constants ───────────────────────────────────────────────────────────────

/** Hard cap on messages fetched per `session.messages` call. Kilo doesn't
 * paginate by default; we pull the most recent slice and dedupe. */
export const KILO_SESSION_MESSAGE_LIMIT = 5000;

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Subset of Kilo's `Message.info` used by Talon for usage accounting.
 * The full type comes from the SDK; we narrow to the fields we read.
 */
export type KiloAssistantInfo = {
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

export type KiloSessionSnapshot = {
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
  info?: KiloAssistantInfo;
  parts: Array<Record<string, unknown>>;
};

type KiloUsageSummary = {
  assistantMessages: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
};

// ── Public: parts → summary ─────────────────────────────────────────────────

/**
 * Walk a parts list, concatenating text and counting tool calls.
 *
 * Returns the joined text (with `\n\n` between adjacent text parts to
 * preserve paragraph structure) and the count of tool-use blocks.
 */
export function extractPartsSummary(parts: Array<Record<string, unknown>>): {
  text: string;
  toolCalls: number;
  syntheticErrorText?: string;
} {
  const textParts: string[] = [];
  const syntheticTexts: string[] = [];
  let toolCalls = 0;

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      // Kilo flags self-generated synthetic text parts (e.g.
      // "The model hit its output limit while reasoning and produced
      // no actionable output. Try disabling reasoning or increasing
      // the output limit.") with `synthetic: true`. Those aren't a
      // reply from the model — they're Kilo telling us the request
      // failed. Surface them through a separate channel so the
      // handler can convert them into a meaningful Talon error
      // instead of shipping them verbatim to the user.
      //
      // The schema also has `ignored: true` but observation shows it's
      // set on regular text-part replies too (Kilo internal flag, not
      // a "skip me" hint as one would assume from the name). Don't
      // filter on it — that wiped out legitimate replies in prod.
      if (part.synthetic === true) {
        syntheticTexts.push(part.text);
      } else {
        textParts.push(part.text);
      }
    } else if (part.type === "tool") {
      toolCalls++;
    }
  }

  const result: {
    text: string;
    toolCalls: number;
    syntheticErrorText?: string;
  } = {
    text: textParts.join("\n\n").trim(),
    toolCalls,
  };
  if (syntheticTexts.length > 0) {
    result.syntheticErrorText = syntheticTexts.join("\n\n").trim();
  }
  return result;
}

/** Extract token / cost counters from a Kilo assistant `info` blob. */
export function extractAssistantUsage(info: KiloAssistantInfo | undefined): {
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

function hasAssistantUsage(info: KiloAssistantInfo | undefined): boolean {
  return Boolean(
    info?.tokens?.input ||
    info?.tokens?.output ||
    info?.tokens?.reasoning ||
    info?.tokens?.cache?.read ||
    info?.tokens?.cache?.write ||
    info?.cost,
  );
}

function createEmptyUsageSummary(): KiloUsageSummary {
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
    info?: KiloAssistantInfo;
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

/**
 * Summarise a batch of session messages into per-turn usage totals.
 *
 * Filters to assistant messages newer than `minCreatedAt`. Returns the
 * latest such message (for context-window/model lookup) and the cumulative
 * token/cost totals across all qualifying messages.
 */
export function summarizeKiloAssistantMessages(
  messages: Array<unknown>,
  minCreatedAt = 0,
): {
  latestAssistant?: ParsedAssistantMessage;
  usage: KiloUsageSummary;
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

// ── Session-messages fetch ──────────────────────────────────────────────────

async function listSessionMessages(
  oc: KiloClient,
  sessionId: string,
  limit = KILO_SESSION_MESSAGE_LIMIT,
): Promise<Array<unknown>> {
  const resp = await oc.session.messages({
    sessionID: sessionId,
    limit,
  });
  const page = Array.isArray(resp.data) ? resp.data : [];
  const messages: Array<unknown> = [];
  const seenMessageIds = new Set<string>();

  for (const message of page) {
    const messageId = (message as Record<string, unknown>)?.info as
      | { id?: string }
      | undefined;
    const id = messageId?.id;
    if (id && seenMessageIds.has(id)) continue;
    if (id) seenMessageIds.add(id);
    messages.push(message);
  }

  return messages;
}

/**
 * Aggregate the most recent turn's assistant messages into a usage summary.
 *
 * `minCreatedAt` filters out messages older than the current turn — the
 * caller typically passes the timestamp of the user message that started
 * the turn.
 */
export async function getKiloTurnSummary(
  oc: KiloClient,
  sessionId: string,
  minCreatedAt: number,
): Promise<{
  latestAssistant?: ParsedAssistantMessage;
  usage: KiloUsageSummary;
}> {
  const messages = await listSessionMessages(oc, sessionId);
  return summarizeKiloAssistantMessages(messages, minCreatedAt);
}

/**
 * Build a {@link KiloSessionSnapshot} for the given session id.
 *
 * Returns `undefined` if no session id was provided (caller convenience —
 * lets `bootstrap.ts` write `getKiloSessionSnapshot(session?.sessionId)`
 * without a null-check before).
 */
export async function getKiloSessionSnapshot(
  sessionId: string,
): Promise<KiloSessionSnapshot | undefined> {
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
  const summary = summarizeKiloAssistantMessages(messages);
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

// ── Pending-question guard ──────────────────────────────────────────────────

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

function isToolApprovalQuestion(
  questions: Array<Record<string, unknown>>,
): boolean {
  return questions.some((q) => {
    const header = String(q.header ?? q.question ?? "").toLowerCase();
    return (
      header.includes("tool") ||
      header.includes("approve") ||
      header.includes("permission") ||
      header.includes("allow")
    );
  });
}

/**
 * Auto-respond to pending Kilo questions for this session.
 *
 * Talon manages its own tool permissions, so any "approve this tool?"
 * Kilo asks is auto-approved with "always". Non-tool questions (which
 * shouldn't normally occur with our config but might appear if the
 * model decided to ask the user something) are rejected so the model
 * gets a definitive answer and keeps moving.
 *
 * Idempotent via `seenQuestionIds`: a question already handled in this
 * turn is not re-handled (Kilo lists pending questions until they're
 * answered, so the loop in the handler can call this every 350ms
 * without re-firing the same answer).
 */
export async function rejectPendingQuestions(
  oc: KiloClient,
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

    try {
      if (isToolApprovalQuestion(questions)) {
        // Auto-approve tool usage — Talon manages its own tool access
        const answers = questions.map(() => ["always"]);
        await oc.question.reply({ requestID: requestId, answers });
        logWarn(
          "agent",
          `[${chatId}] Auto-approved Kilo tool question ${requestId}${
            summary ? `: ${summary}` : ""
          }`,
        );
      } else {
        await oc.question.reject({ requestID: requestId });
        logWarn(
          "agent",
          `[${chatId}] Rejected Kilo question ${requestId}${
            summary ? `: ${summary}` : ""
          }`,
        );
      }
    } catch (err) {
      logWarn(
        "agent",
        `[${chatId}] Failed to handle Kilo question ${requestId}: ${errMsg(err)}`,
      );
    }
  }
}

// ── Assistant-reply fallback poll ───────────────────────────────────────────

/**
 * Wait up to 10s for an assistant message to land in the session.
 *
 * Used by the handler as a safety net when `session.prompt` returns but
 * the response parts list is empty (Kilo occasionally closes the prompt
 * before the assistant message has been persisted to the messages
 * endpoint — a race condition we work around by polling).
 *
 * Returns the first qualifying assistant message's text + tool count,
 * or `{ text: "", toolCalls: 0 }` if the deadline passes without one.
 */
export async function waitForAssistantReply(
  oc: KiloClient,
  sessionId: string,
  minCreatedAt: number,
  chatId: string,
  seenQuestionIds: Set<string>,
): Promise<{
  text: string;
  toolCalls: number;
  info?: KiloAssistantInfo;
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

// ── Legacy: question-guarded prompt wrapper ─────────────────────────────────
//
// The legacy `waitForPromptWithQuestionGuard` shipped pre-streaming Kilo.
// The streaming handler in `handler.ts` runs the question watchdog and
// the prompt() call directly, so this wrapper is no longer used by the
// chat handler. It's still exported for the one-shot runner, which uses
// the simpler "prompt → answer questions" loop (no streaming UX needed
// for heartbeat / dream runs).

export async function waitForPromptWithQuestionGuard(
  oc: KiloClient,
  parameters: Parameters<KiloClient["session"]["prompt"]>[0],
  chatId: string,
  seenQuestionIds: Set<string>,
): Promise<Awaited<ReturnType<KiloClient["session"]["prompt"]>>> {
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
          `[${chatId}] Failed while polling Kilo questions: ${errMsg(err)}`,
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
