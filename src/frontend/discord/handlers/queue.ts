/**
 * Message queue — debounces rapid-fire messages per chat (concatenating them
 * into a single agent turn) with one transient retry, then best-effort error
 * notification.
 */

import { classify, friendlyMessage } from "../../../core/errors.js";
import {
  recordMessageProcessed,
  recordMessageReceived,
  recordError,
} from "../../../util/watchdog.js";
import { appendDailyLog } from "../../../storage/daily-log.js";
import { log, logError } from "../../../util/log.js";
import { processAndReply } from "./delivery.js";
import { sendChunked } from "./context.js";
import {
  messageQueues,
  DEBOUNCE_MS,
  MAX_QUEUED_PER_CHAT,
  type QueuedMessage,
} from "./state.js";
import type { TalonConfig } from "../../../util/config.js";

export function enqueueMessage(
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
    chatId,
    numericChatId,
  });
}

async function flushQueue(chatId: string): Promise<void> {
  const entry = messageQueues.get(chatId);
  if (!entry) return;
  messageQueues.delete(chatId);

  const { messages, config, numericChatId } = entry;
  const last = messages[messages.length - 1];
  const combinedPrompt =
    messages.length === 1
      ? messages[0].prompt
      : messages.map((m) => m.prompt).join("\n\n");

  appendDailyLog(last.senderName, combinedPrompt, {
    chatTitle: last.chatTitle,
    username: last.senderUsername,
  });

  const runTurn = () =>
    processAndReply({
      config,
      chatId,
      numericChatId,
      replyToId: last.replyToId,
      messageId: last.messageId,
      numericMessageId: last.numericMessageId,
      prompt: combinedPrompt,
      senderName: last.senderName,
      isGroup: last.isGroup,
      senderUsername: last.senderUsername,
      senderId: last.senderId,
      channel: last.channel,
      chatTitle: last.chatTitle,
    });

  try {
    await runTurn();
    recordMessageProcessed();
  } catch (err) {
    const classified = classify(err);
    const promptPreview = combinedPrompt.slice(0, 100).replace(/\n/g, " ");
    logError(
      "bot",
      `[${chatId}] [${last.isGroup ? "guild" : "DM"}] [${last.senderName}] ${classified.reason}: ${classified.message} | prompt: "${promptPreview}"`,
    );
    recordError(classified.message);

    if (classified.retryable) {
      const delayMs = classified.retryAfterMs ?? 2000;
      log(
        "bot",
        `[${chatId}] Retrying after ${classified.reason} (${delayMs}ms)...`,
      );
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        await runTurn();
        recordMessageProcessed();
        return;
      } catch (retryErr) {
        const retryClassified = classify(retryErr);
        logError("bot", `[${chatId}] Retry failed: ${retryClassified.message}`);
        // Error-recovery send must never throw — if the network is fully down
        // the queue handler would otherwise propagate up and stall future
        // messages. Best-effort: notify if we can, log + move on otherwise.
        try {
          await sendChunked(
            last.channel,
            friendlyMessage(retryClassified),
            last.replyToId,
          );
        } catch (notifyErr) {
          logError(
            "bot",
            `[${chatId}] Could not notify user about retry failure: ${notifyErr instanceof Error ? notifyErr.message : notifyErr}`,
          );
        }
        return;
      }
    }
    try {
      await sendChunked(
        last.channel,
        friendlyMessage(classified),
        last.replyToId,
      );
    } catch (notifyErr) {
      logError(
        "bot",
        `[${chatId}] Could not notify user about error: ${notifyErr instanceof Error ? notifyErr.message : notifyErr}`,
      );
    }
  }
}
