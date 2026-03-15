/**
 * History capture middleware — runs for ALL messages, before handlers.
 * Records every message into the in-memory history buffer.
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../util/config.js";
import { pushMessage } from "../storage/history.js";
import { allowChat } from "../telegram/userbot.js";
import { registerChat } from "../agent/proactive.js";
import { getSenderName } from "./handlers.js";
import {
  handleTextMessage,
  handlePhotoMessage,
  handleDocumentMessage,
  handleVoiceMessage,
  handleStickerMessage,
  handleVideoMessage,
  handleAnimationMessage,
} from "./handlers.js";

export function registerMiddleware(bot: Bot, config: TalonConfig): void {
  // ── History capture (runs for ALL messages, before handlers) ─────────────
  bot.on("message", (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const sender = getSenderName(ctx.from);
    const senderId = ctx.from?.id ?? 0;
    const msgId = ctx.message.message_id;
    const replyToMsgId = ctx.message.reply_to_message?.message_id;

    // Register this chat for userbot + pulse access
    allowChat(ctx.chat.id);
    registerChat(chatId);
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
}
