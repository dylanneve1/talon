/**
 * Teams activity handlers — processes incoming Activities from Teams.
 *
 * Handles message activities, conversation updates, and invoke activities.
 * Implements debouncing and rate limiting matching the Telegram frontend patterns.
 */

import {
  ActivityHandler,
  TurnContext,
  type Activity,
} from "botbuilder";
import type { TalonConfig } from "../../util/config.js";
import { execute } from "../../core/dispatcher.js";
import { classify, friendlyMessage } from "../../core/errors.js";
import { enrichDMPrompt, enrichGroupPrompt } from "../../core/prompt-builder.js";
import { pushMessage } from "../../storage/history.js";
import { registerChat } from "../../core/pulse.js";
import { appendDailyLog } from "../../storage/daily-log.js";
import { recordMessageProcessed, recordError } from "../../util/watchdog.js";
import { saveConversationReference } from "./conversation-store.js";
import { log, logError } from "../../util/log.js";
import { splitMessage } from "./formatting.js";

const TEAMS_PREFIX = "teams:";
function teamsChatId(convId: string): string { return TEAMS_PREFIX + convId; }
export function teamsConvId(chatId: string): string { return chatId.slice(TEAMS_PREFIX.length); }

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Deterministic hash of a string to a stable positive integer.
 *  Needed because Teams uses UUID strings for user IDs but history expects numbers. */
function hashStringId(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ── Rate limiting ───────────────────────────────────────────────────────────

const userMessageTimestamps = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MESSAGES = 15;

function isUserRateLimited(userId: string): boolean {
  const now = Date.now();
  let timestamps = userMessageTimestamps.get(userId);
  if (!timestamps) {
    timestamps = [];
    userMessageTimestamps.set(userId, timestamps);
  }
  while (timestamps.length > 0 && timestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= RATE_LIMIT_MAX_MESSAGES) return true;
  timestamps.push(now);
  // Evict stale entries
  if (userMessageTimestamps.size > 5_000) {
    const cutoff = now - 10 * 60_000;
    for (const [uid, ts] of userMessageTimestamps) {
      if (ts.length === 0 || ts[ts.length - 1] < cutoff) {
        userMessageTimestamps.delete(uid);
      }
      if (userMessageTimestamps.size <= 2_500) break;
    }
  }
  return false;
}

// ── Message queue (debounce rapid-fire messages) ────────────────────────────

type QueuedMessage = {
  prompt: string;
  senderName: string;
  senderId: string;
  isGroup: boolean;
};

const messageQueues = new Map<
  string,
  {
    messages: QueuedMessage[];
    timer: ReturnType<typeof setTimeout>;
    config: TalonConfig;
    turnContext: TurnContext;
  }
>();

const DEBOUNCE_MS = 500;
const MAX_QUEUED_PER_CHAT = 20;

function enqueueMessage(
  config: TalonConfig,
  chatId: string,
  msg: QueuedMessage,
  context: TurnContext,
): void {
  const existing = messageQueues.get(chatId);
  if (existing) {
    if (existing.messages.length >= MAX_QUEUED_PER_CHAT) return;
    existing.messages.push(msg);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushQueue(chatId), DEBOUNCE_MS);
    return;
  }
  messageQueues.set(chatId, {
    messages: [msg],
    timer: setTimeout(() => flushQueue(chatId), DEBOUNCE_MS),
    config,
    turnContext: context,
  });
}

async function flushQueue(chatId: string): Promise<void> {
  const entry = messageQueues.get(chatId);
  if (!entry) return;
  messageQueues.delete(chatId);

  const { messages, config, turnContext } = entry;
  if (messages.length === 0) return;

  const last = messages[messages.length - 1];
  const combinedPrompt =
    messages.length === 1
      ? messages[0].prompt
      : messages.map((m) => m.prompt).join("\n\n");

  const logSummary = combinedPrompt.slice(0, 80).replace(/\n/g, " ");
  appendDailyLog(last.senderName, logSummary);

  try {
    await processAndReply({
      config,
      chatId,
      prompt: combinedPrompt,
      senderName: last.senderName,
      senderId: last.senderId,
      isGroup: last.isGroup,
      turnContext,
    });
    recordMessageProcessed();
  } catch (err) {
    const classified = classify(err);
    logError(
      "teams",
      `[${chatId}] [${last.senderName}] ${classified.reason}: ${classified.message}`,
    );
    recordError(classified.message);

    if (classified.retryable) {
      const delayMs = classified.retryAfterMs ?? 2000;
      log("teams", `[${chatId}] Retrying after ${classified.reason} (${delayMs}ms)...`);
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        await processAndReply({
          config, chatId,
          prompt: combinedPrompt,
          senderName: last.senderName,
          senderId: last.senderId,
          isGroup: last.isGroup,
          turnContext,
        });
        return;
      } catch (retryErr) {
        const retryClassified = classify(retryErr);
        logError("teams", `[${chatId}] Retry failed: ${retryClassified.message}`);
        try {
          await turnContext.sendActivity(friendlyMessage(retryClassified));
        } catch { /* can't send error */ }
        return;
      }
    }

    try {
      await turnContext.sendActivity(friendlyMessage(classified));
    } catch { /* can't send error */ }
  }
}

// ── Response delivery ───────────────────────────────────────────────────────

type ProcessParams = {
  config: TalonConfig;
  chatId: string;
  prompt: string;
  senderName: string;
  senderId: string;
  isGroup: boolean;
  turnContext: TurnContext;
};

async function processAndReply(params: ProcessParams): Promise<void> {
  const { config, chatId, prompt, senderName, senderId, isGroup, turnContext } = params;

  let enrichedPrompt = prompt;
  if (!isGroup && senderName) {
    enrichedPrompt = enrichDMPrompt(prompt, senderName);
  } else if (isGroup && senderId) {
    enrichedPrompt = enrichGroupPrompt(prompt, chatId, hashStringId(senderId));
  }

  const onTextBlock = async (text: string) => {
    const chunks = splitMessage(text, config.maxMessageLength);
    for (const chunk of chunks) {
      await turnContext.sendActivity(chunk);
    }
  };

  const result = await execute({
    chatId,
    prompt: enrichedPrompt,
    senderName,
    isGroup,
    source: "message",
    onTextBlock,
  });

  // Deliver final response if tools didn't already send one
  if (result.bridgeMessageCount === 0 && result.text && result.text.length > 20) {
    const chunks = splitMessage(result.text, config.maxMessageLength);
    for (const chunk of chunks) {
      await turnContext.sendActivity(chunk);
    }
  }
}

// ── Mention stripping ───────────────────────────────────────────────────────

function stripBotMention(text: string, activity: Partial<Activity>): string {
  if (!activity.entities) return text;
  for (const entity of activity.entities) {
    if (entity.type === "mention" && entity.mentioned?.id === activity.recipient?.id) {
      // Remove <at>BotName</at> tag
      const mentionText = entity.text ?? "";
      text = text.replace(mentionText, "").trim();
    }
  }
  return text;
}

// ── Activity handler ────────────────────────────────────────────────────────

export function createTeamsActivityHandler(config: TalonConfig): ActivityHandler {
  const handler = new ActivityHandler();

  handler.onMessage(async (context, next) => {
    const activity = context.activity;
    const conversationId = activity.conversation?.id;
    if (!conversationId) return next();

    const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "unknown";
    const senderName = activity.from?.name ?? "User";
    const chatId = teamsChatId(conversationId);

    if (isUserRateLimited(senderId)) return next();

    // Store conversation reference for proactive messaging (raw convId)
    const ref = TurnContext.getConversationReference(activity);
    saveConversationReference(conversationId, ref);

    // Determine conversation type
    const conversationType = activity.conversation?.conversationType ?? "personal";
    const isGroup = conversationType === "channel" || conversationType === "groupChat";

    // Register groups for pulse
    if (isGroup) registerChat(chatId);

    // Extract text, stripping bot @mention in channels
    let text = activity.text ?? "";
    if (isGroup) {
      text = stripBotMention(text, activity);
    }
    if (!text.trim()) return next();

    // Push to in-memory history
    pushMessage(chatId, {
      msgId: Date.now(), // Teams doesn't have numeric message IDs
      senderId: hashStringId(senderId),
      senderName,
      text,
      timestamp: activity.timestamp ? new Date(activity.timestamp).getTime() : Date.now(),
    });

    // Enqueue for processing
    enqueueMessage(config, chatId, {
      prompt: text,
      senderName,
      senderId,
      isGroup,
    }, context);

    return next();
  });

  handler.onConversationUpdate(async (context, next) => {
    const activity = context.activity;
    const conversationId = activity.conversation?.id;
    if (!conversationId) return next();

    // Store reference on any conversation update (raw convId)
    const ref = TurnContext.getConversationReference(activity);
    saveConversationReference(conversationId, ref);

    // Check if bot was added
    if (activity.membersAdded) {
      for (const member of activity.membersAdded) {
        if (member.id === activity.recipient?.id) {
          log("teams", `Bot added to conversation: ${conversationId}`);
          await context.sendActivity(
            "Hello! I'm Talon, an AI assistant powered by Claude. Send me a message to get started.",
          );
        }
      }
    }

    return next();
  });

  return handler;
}
