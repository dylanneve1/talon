/**
 * Messaging actions — send/reply/edit/delete/pin/forward/copy/react,
 * inline-button messages, chat actions, and scheduled messages.
 */

import { markdownToTelegramHtml } from "../formatting.js";
import { withRetry } from "../../../core/engine/gateway.js";
import { logError, logWarn } from "../../../util/log.js";
import { sendText, toPositiveId } from "./shared.js";
import { TELEGRAM_MAX_TEXT, type TelegramActionHandlers } from "./types.js";

export const messagingHandlers: TelegramActionHandlers = {
  send_message: async (body, chatId, { bot, gateway }) => {
    const text = String(body.text ?? "");
    const replyTo = toPositiveId(body.reply_to_message_id);
    gateway.incrementMessages(chatId);
    const msgId = await withRetry(() => sendText(bot, chatId, text, replyTo));
    return { ok: true, message_id: msgId };
  },

  reply_to: async (body, chatId, { bot, gateway }) => {
    const msgId = Number(body.message_id);
    gateway.incrementMessages(chatId);
    const sentId = await withRetry(() =>
      sendText(bot, chatId, String(body.text ?? ""), msgId),
    );
    return { ok: true, message_id: sentId };
  },

  react: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const emoji = String(body.emoji ?? "👍");
    try {
      await withRetry(() =>
        bot.api.setMessageReaction(chatId, Number(body.message_id), [
          { type: "emoji", emoji: emoji as "👍" },
        ]),
      );
    } catch (err) {
      logWarn(
        "bot",
        `Custom emoji reaction failed, falling back to 👍: ${err instanceof Error ? err.message : err}`,
      );
      try {
        await bot.api.setMessageReaction(chatId, Number(body.message_id), [
          { type: "emoji", emoji: "👍" },
        ]);
      } catch (e) {
        return {
          ok: false,
          error: `Reaction failed: ${e instanceof Error ? e.message : e}`,
        };
      }
    }
    return { ok: true };
  },

  edit_message: async (body, chatId, { bot }) => {
    const text = String(body.text ?? "");
    if (text.length > TELEGRAM_MAX_TEXT)
      return {
        ok: false,
        error: `Text too long (max ${TELEGRAM_MAX_TEXT})`,
      };
    const html = markdownToTelegramHtml(text);
    await withRetry(async () => {
      try {
        await bot.api.editMessageText(chatId, Number(body.message_id), html, {
          parse_mode: "HTML",
        });
      } catch {
        await bot.api.editMessageText(chatId, Number(body.message_id), text);
      }
    });
    return { ok: true };
  },

  delete_message: async (body, chatId, { bot }) => {
    await bot.api.deleteMessage(chatId, Number(body.message_id));
    return { ok: true };
  },

  pin_message: async (body, chatId, { bot }) => {
    await bot.api.pinChatMessage(chatId, Number(body.message_id));
    return { ok: true };
  },

  unpin_message: async (body, chatId, { bot }) => {
    await bot.api.unpinChatMessage(
      chatId,
      body.message_id ? Number(body.message_id) : undefined,
    );
    return { ok: true };
  },

  forward_message: async (body, chatId, { bot }) => {
    if (body.to_chat_id && Number(body.to_chat_id) !== chatId)
      return { ok: false, error: "Cross-chat forwarding not allowed." };
    const sent = await bot.api.forwardMessage(
      chatId,
      chatId,
      Number(body.message_id),
    );
    return { ok: true, message_id: sent.message_id };
  },

  copy_message: async (body, chatId, { bot }) => {
    const sent = await bot.api.copyMessage(
      chatId,
      chatId,
      Number(body.message_id),
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_chat_action: async (body, chatId, { bot }) => {
    await bot.api.sendChatAction(
      chatId,
      String(body.chat_action ?? "typing") as "typing",
    );
    return { ok: true };
  },

  send_message_with_buttons: async (body, chatId, { bot, gateway }) => {
    const text = String(body.text ?? "");
    if (text.length > TELEGRAM_MAX_TEXT)
      return { ok: false, error: `Text too long` };
    const html = markdownToTelegramHtml(text);
    const rows = body.rows as Array<
      Array<{ text: string; url?: string; callback_data?: string }>
    >;
    gateway.incrementMessages(chatId);
    const keyboard = rows.map((row) =>
      row.map((btn) =>
        btn.url
          ? { text: btn.text, url: btn.url }
          : {
              text: btn.text,
              callback_data: btn.callback_data ?? btn.text,
            },
      ),
    );
    try {
      const sent = await bot.api.sendMessage(chatId, html, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      });
      return { ok: true, message_id: sent.message_id };
    } catch {
      const sent = await bot.api.sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: keyboard },
      });
      return { ok: true, message_id: sent.message_id };
    }
  },

  schedule_message: (body, chatId, { bot, scheduledMessages }) => {
    const text = String(body.text ?? "");
    const replyTo = toPositiveId(body.reply_to_message_id);
    const rows = body.rows as
      | Array<Array<{ text: string; url?: string; callback_data?: string }>>
      | undefined;
    const delaySec = Math.max(
      1,
      Math.min(3600, Number(body.delay_seconds ?? 60)),
    );
    const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(async () => {
      try {
        if (rows) {
          const keyboard = rows.map((row) =>
            row.map((btn) =>
              btn.url
                ? { text: btn.text, url: btn.url }
                : {
                    text: btn.text,
                    callback_data: btn.callback_data ?? btn.text,
                  },
            ),
          );
          await bot.api.sendMessage(chatId, markdownToTelegramHtml(text), {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard },
            reply_parameters: replyTo ? { message_id: replyTo } : undefined,
          });
        } else {
          await sendText(bot, chatId, text, replyTo);
        }
      } catch (err) {
        logError("bot", `Scheduled message failed (chat=${chatId})`, err);
      }
      scheduledMessages.delete(scheduleId);
    }, delaySec * 1000);
    scheduledMessages.set(scheduleId, timer);
    return { ok: true, schedule_id: scheduleId, delay_seconds: delaySec };
  },

  cancel_scheduled: (body, _chatId, { scheduledMessages }) => {
    const timer = scheduledMessages.get(String(body.schedule_id ?? ""));
    if (timer) {
      clearTimeout(timer);
      scheduledMessages.delete(String(body.schedule_id));
      return { ok: true, cancelled: true };
    }
    return { ok: false, error: "Schedule not found" };
  },
};
