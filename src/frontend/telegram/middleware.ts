/**
 * History capture middleware — runs for ALL messages, before handlers.
 * Records every message into the in-memory history buffer.
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../util/config.js";
import { pushMessage } from "../../storage/history.js";
import { allowChat } from "./userbot.js";
import { registerChat } from "../../core/pulse.js";
import { getSenderName } from "./handlers.js";
import {
  handleTextMessage,
  handlePhotoMessage,
  handleDocumentMessage,
  handleVoiceMessage,
  handleStickerMessage,
  handleVideoMessage,
  handleAnimationMessage,
  handleAudioMessage,
  handleVideoNoteMessage,
} from "./handlers.js";

export function registerMiddleware(bot: Bot, config: TalonConfig): void {
  // ── History capture (runs for ALL messages, before handlers) ─────────────
  bot.on("message", (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const sender = getSenderName(ctx.from);
    const senderId = ctx.from?.id ?? 0;
    const msgId = ctx.message.message_id;
    const replyToMsgId = ctx.message.reply_to_message?.message_id;

    // Register this chat for userbot access
    allowChat(ctx.chat.id);
    // Only register groups for pulse (DMs don't need it — bot always responds)
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
    if (isGroup) registerChat(chatId);
    const timestamp = ctx.message.date * 1000;

    if ("text" in ctx.message && ctx.message.text) {
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        text: ctx.message.text,
        replyToMsgId,
        timestamp,
      });
    } else if ("photo" in ctx.message && ctx.message.photo) {
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        text: ctx.message.caption || "(photo)",
        replyToMsgId,
        timestamp,
        mediaType: "photo",
      });
    } else if ("document" in ctx.message && ctx.message.document) {
      const name = ctx.message.document.file_name || "file";
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        text: ctx.message.caption || `(sent ${name})`,
        replyToMsgId,
        timestamp,
        mediaType: "document",
      });
    } else if ("voice" in ctx.message && ctx.message.voice) {
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        text: "(voice message)",
        replyToMsgId,
        timestamp,
        mediaType: "voice",
      });
    } else if ("sticker" in ctx.message && ctx.message.sticker) {
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        text: ctx.message.sticker.emoji || "(sticker)",
        replyToMsgId,
        timestamp,
        mediaType: "sticker",
        stickerFileId: ctx.message.sticker.file_id,
      });
    } else if ("video" in ctx.message && ctx.message.video) {
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        text: ctx.message.caption || "(video)",
        replyToMsgId,
        timestamp,
        mediaType: "video",
      });
    } else if ("animation" in ctx.message && ctx.message.animation) {
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        text: ctx.message.caption || "(GIF)",
        replyToMsgId,
        timestamp,
        mediaType: "animation",
      });
    } else if ("audio" in ctx.message && ctx.message.audio) {
      const title = ctx.message.audio.title || ctx.message.audio.file_name || "audio";
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        text: ctx.message.caption || `(audio: ${title})`,
        replyToMsgId,
        timestamp,
        mediaType: "document", // treat audio like documents in history
      });
    } else if ("video_note" in ctx.message && ctx.message.video_note) {
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        text: "(video note)",
        replyToMsgId,
        timestamp,
        mediaType: "video",
      });
    } else if ("location" in ctx.message && ctx.message.location) {
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        text: `(shared location: ${ctx.message.location.latitude}, ${ctx.message.location.longitude})`,
        replyToMsgId,
        timestamp,
      });
    } else if ("contact" in ctx.message && ctx.message.contact) {
      const name = [ctx.message.contact.first_name, ctx.message.contact.last_name].filter(Boolean).join(" ");
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        text: `(shared contact: ${name})`,
        replyToMsgId,
        timestamp,
      });
    }

    return next();
  });

  // ── Message handlers (delegated to handlers.ts) ──────────────────────────
  bot.on("message:text", (ctx) => handleTextMessage(ctx, bot, config));
  bot.on("message:photo", (ctx) => handlePhotoMessage(ctx, bot, config));
  bot.on("message:document", (ctx) => handleDocumentMessage(ctx, bot, config));
  bot.on("message:voice", (ctx) => handleVoiceMessage(ctx, bot, config));
  bot.on("message:sticker", (ctx) => handleStickerMessage(ctx, bot, config));
  bot.on("message:video", (ctx) => handleVideoMessage(ctx, bot, config));
  bot.on("message:animation", (ctx) => handleAnimationMessage(ctx, bot, config));
  bot.on("message:audio", (ctx) => handleAudioMessage(ctx, bot, config));
  bot.on("message:video_note", (ctx) => handleVideoNoteMessage(ctx, bot, config));
}
