/**
 * Message queue + per-user rate limiting.
 *
 * Debounces rapid-fire messages per chat (concatenating them into a single
 * agent turn), tracks per-user rate limits, and surfaces a "messages were
 * skipped" notice for groups.
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../../util/config.js";
import { escapeHtml } from "../formatting.js";
import { classify, friendlyMessage } from "../../../core/errors.js";
import {
  getRecentHistory,
  type HistoryMessage,
} from "../../../storage/history.js";
import {
  recordMessageProcessed,
  recordMessageReceived,
  recordError,
} from "../../../util/watchdog.js";
import { log, logError, logWarn, logDebug } from "../../../util/log.js";
import { appendDailyLog } from "../../../storage/daily-log.js";
import { processAndReply, sendHtml } from "./delivery.js";
import {
  messageQueues,
  lastHandledMessageIdByChat,
  userMessageTimestamps,
  DEBOUNCE_MS,
  MAX_QUEUED_PER_CHAT,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_MESSAGES,
  type QueuedMessage,
} from "./state.js";

export function isUserRateLimited(senderId: number): boolean {
  const now = Date.now();
  let timestamps = userMessageTimestamps.get(senderId);
  if (!timestamps) {
    timestamps = [];
    userMessageTimestamps.set(senderId, timestamps);
  }

  // Remove old entries outside the window
  while (timestamps.length > 0 && timestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    timestamps.shift();
  }

  if (timestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
    logDebug("bot", `Rate-limited user ${senderId}`);
    return true;
  }

  timestamps.push(now);

  // Evict stale entries — remove users who haven't messaged in 10+ minutes
  if (userMessageTimestamps.size > 5_000) {
    const cutoff = now - 10 * 60_000;
    for (const [userId, ts] of userMessageTimestamps) {
      if (ts.length === 0 || ts[ts.length - 1] < cutoff) {
        userMessageTimestamps.delete(userId);
      }
      if (userMessageTimestamps.size <= 2_500) break; // evict down to half
    }
  }

  return false;
}

/**
 * Enqueue a message for processing. If another message arrives within DEBOUNCE_MS,
 * they are concatenated and sent as a single query to avoid duplicate SDK spawns.
 * Queued messages get a hourglass reaction to indicate they've been seen.
 */
export function enqueueMessage(
  bot: Bot,
  config: TalonConfig,
  chatId: string,
  numericChatId: number,
  msg: QueuedMessage,
): void {
  // Tell the watchdog work has arrived — stuck detection compares this
  // against processing completions (idle chats must never look wedged).
  recordMessageReceived();
  const existing = messageQueues.get(chatId);
  if (existing) {
    if (existing.messages.length >= MAX_QUEUED_PER_CHAT) return; // drop excess
    existing.messages.push(msg);
    // Show hourglass reaction on the queued message to indicate it's been seen
    bot.api
      .setMessageReaction(numericChatId, msg.messageId, [
        {
          type: "emoji",
          emoji: "⏳" as "👍" /* grammY wants union type */,
        },
      ])
      .catch(() => {});
    existing.queuedReactionMsgIds.push(msg.messageId);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushQueue(chatId), DEBOUNCE_MS);
    return;
  }

  const entry = {
    messages: [msg],
    timer: setTimeout(() => flushQueue(chatId), DEBOUNCE_MS),
    bot,
    config,
    numericChatId,
    queuedReactionMsgIds: [] as number[],
  };
  messageQueues.set(chatId, entry);
}

async function flushQueue(chatId: string): Promise<void> {
  const entry = messageQueues.get(chatId);
  if (!entry) return;
  messageQueues.delete(chatId);

  const { messages, bot, config, numericChatId, queuedReactionMsgIds } = entry;

  // Clear hourglass reactions on queued messages now that we're processing
  for (const msgId of queuedReactionMsgIds) {
    bot.api.setMessageReaction(numericChatId, msgId, []).catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      // The id is recorded optimistically — the hourglass `setMessageReaction`
      // above is fire-and-forget, so we queue the clear before knowing the set
      // landed. When it didn't, clearing a reaction that was never there comes
      // back as REACTION_EMPTY. The end state we wanted (no reaction) already
      // holds, so that is a no-op, not a failure. Keeping the optimistic push
      // matters: gating it on the set resolving would race the flush and strand
      // a ⏳ on the message. Anything else is still worth surfacing.
      if (detail.includes("REACTION_EMPTY")) return;
      logWarn("bot", `Failed to clear reaction on msg ${msgId}: ${detail}`);
    });
  }

  // Use last message's metadata for reply context
  const first = messages[0];
  const last = messages[messages.length - 1];

  // Concatenate prompts (with newlines between them if multiple)
  const combinedPrompt =
    messages.length === 1
      ? messages[0].prompt
      : messages.map((m) => m.prompt).join("\n\n");
  const groupGapContext = buildGroupGapContextNotice({
    isGroup: last.isGroup,
    chatId,
    firstQueuedMessageId: first.messageId,
    lastHandledMessageId: lastHandledMessageIdByChat.get(chatId),
  });
  const promptWithContext = groupGapContext
    ? `${groupGapContext}\n\n${combinedPrompt}`
    : combinedPrompt;

  const chatContext = {
    chatTitle: last.chatTitle,
    username: last.senderUsername,
  };
  appendDailyLog(last.senderName, promptWithContext, chatContext);

  const runTurn = () =>
    processAndReply({
      bot,
      config,
      chatId,
      numericChatId,
      replyToId: last.replyToId,
      messageId: last.messageId,
      prompt: promptWithContext,
      senderName: last.senderName,
      isGroup: last.isGroup,
      senderUsername: last.senderUsername,
      senderId: last.senderId,
      chatTitle: last.chatTitle,
    });

  try {
    await runTurn();
    lastHandledMessageIdByChat.set(chatId, last.messageId);
    recordMessageProcessed();
  } catch (err) {
    const classified = classify(err);
    const chatType = last.isGroup ? "group" : "DM";
    const promptPreview = promptWithContext.slice(0, 100).replace(/\n/g, " ");
    logError(
      "bot",
      `[${chatId}] [${chatType}] [${last.senderName}] ${classified.reason}: ${classified.message} | prompt: "${promptPreview}"`,
    );
    recordError(classified.message);

    // Retry once for transient errors (rate_limit, overloaded, network)
    if (classified.retryable) {
      const delayMs = classified.retryAfterMs ?? 2000;
      log(
        "bot",
        `[${chatId}] Retrying after ${classified.reason} (${delayMs}ms)...`,
      );
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        await runTurn();
        lastHandledMessageIdByChat.set(chatId, last.messageId);
        recordMessageProcessed();
        return;
      } catch (retryErr) {
        const retryClassified = classify(retryErr);
        logError(
          "bot",
          `[${chatId}] [${chatType}] Retry failed: ${retryClassified.message}`,
        );
        await sendHtml(
          bot,
          numericChatId,
          escapeHtml(friendlyMessage(retryClassified)),
          last.replyToId,
        );
        return;
      }
    }

    await sendHtml(
      bot,
      numericChatId,
      escapeHtml(friendlyMessage(classified)),
      last.replyToId,
    );
  }
}

export function buildGroupGapContextNotice(inputs: {
  isGroup: boolean;
  chatId: string;
  firstQueuedMessageId: number;
  lastHandledMessageId?: number;
  history?: HistoryMessage[];
}): string {
  if (!inputs.isGroup || inputs.lastHandledMessageId === undefined) return "";

  const history = inputs.history ?? getRecentHistory(inputs.chatId, 100);
  const interveningCount = history.filter(
    (m) =>
      m.msgId > inputs.lastHandledMessageId! &&
      m.msgId < inputs.firstQueuedMessageId,
  ).length;
  if (interveningCount === 0) return "";

  const noun = interveningCount === 1 ? "message" : "messages";
  return (
    `[Group context notice: ${interveningCount} ${noun} were sent in this ` +
    "chat since your last handled turn. If this prompt is vague, ambiguous, " +
    "or asks what you think, use read_chat_history before answering.]"
  );
}
