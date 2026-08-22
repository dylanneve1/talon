/**
 * History capture middleware — runs for ALL messages, before handlers.
 * Records every message into the in-memory history buffer.
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../util/config.js";
import { pushMessage } from "../../storage/history.js";
import { allowChat, revokeChat } from "./userbot.js";
import { registerChat } from "../../core/background/pulse.js";
import { log } from "../../util/log.js";
import { getSenderName } from "./handlers/index.js";
import { noteUpdateId } from "./update-offset.js";
import { noteInboundThread } from "./topics.js";
import { recordJoinRequest } from "./join-requests.js";
import { newlyAddedEmojis, recordReactionToBot } from "../../core/soul/taps.js";
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
} from "./handlers/index.js";

export function registerMiddleware(bot: Bot, config: TalonConfig): void {
  // ── Update-offset tracking (every update, before anything else) ──────────
  // Telegram redelivers any update whose id was never confirmed; the
  // shutdown path confirms this one so a process-ending command can't be
  // served twice. See update-offset.ts.
  bot.use((ctx, next) => {
    noteUpdateId(ctx.update.update_id);
    return next();
  });

  // ── History capture (runs for ALL messages, before handlers) ─────────────
  bot.on("message", (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const sender = getSenderName(ctx.from);
    // Keep the ambient forum topic current so outbound sends (which have no
    // reply anchor — drafts, media, plain sends) land in the topic the
    // conversation is actually happening in, not General.
    noteInboundThread(ctx.chat.id, ctx.message);
    // The handle is the only addressable form of a user — persist it with
    // every row so later readers (history views, heartbeat-composed
    // messages) can mention someone instead of guessing.
    const senderHandle = ctx.from?.username;
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
        senderHandle,
        text: ctx.message.text,
        replyToMsgId,
        timestamp,
      });
    } else if ("photo" in ctx.message && ctx.message.photo) {
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        senderHandle,
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
        senderHandle,
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
        senderHandle,
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
        senderHandle,
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
        senderHandle,
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
        senderHandle,
        text: ctx.message.caption || "(GIF)",
        replyToMsgId,
        timestamp,
        mediaType: "animation",
      });
    } else if ("audio" in ctx.message && ctx.message.audio) {
      const title =
        ctx.message.audio.title || ctx.message.audio.file_name || "audio";
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        senderHandle,
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
        senderHandle,
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
        senderHandle,
        text: `(shared location: ${ctx.message.location.latitude}, ${ctx.message.location.longitude})`,
        replyToMsgId,
        timestamp,
      });
    } else if ("contact" in ctx.message && ctx.message.contact) {
      const name = [
        ctx.message.contact.first_name,
        ctx.message.contact.last_name,
      ]
        .filter(Boolean)
        .join(" ");
      pushMessage(chatId, {
        msgId,
        senderId,
        senderName: sender,
        senderHandle,
        text: `(shared contact: ${name})`,
        replyToMsgId,
        timestamp,
      });
    }

    return next();
  });

  // ── Reaction tap — feed reactions on Talon's own messages to the soul ────
  // Telegram only delivers `message_reaction` updates when subscribed via
  // allowed_updates (see index.ts) and, in groups, when the bot is an admin.
  // The handler is inert unless the soul is enabled.
  bot.on("message_reaction", (ctx) => {
    const mr = ctx.messageReaction;
    // Ignore the bot reacting to messages itself.
    if (mr.user?.id === ctx.me.id) return;
    const added = newlyAddedEmojis(mr.old_reaction, mr.new_reaction);
    recordReactionToBot(mr.chat.id, mr.message_id, added);
  });

  // ── Join requests — cache for moderate(op="list_join_requests") ─────────
  // Delivered only when subscribed via allowed_updates (see index.ts) and
  // the bot admins a chat whose invite link requires approval. Stored, not
  // enqueued: a join request isn't a conversation turn.
  bot.on("chat_join_request", (ctx) => {
    const req = ctx.chatJoinRequest;
    recordJoinRequest(ctx.chat.id, {
      userId: req.from.id,
      name: getSenderName(req.from),
      username: req.from.username,
      bio: req.bio,
      at: Date.now(),
    });
    log(
      "bot",
      `Join request for chat ${ctx.chat.id} from ${req.from.id} (@${req.from.username ?? "?"})`,
    );
  });

  // ── Bot removed from group — revoke userbot access ─────────────────────
  bot.on("my_chat_member", (ctx) => {
    const newStatus = ctx.myChatMember.new_chat_member.status;
    if (newStatus === "left" || newStatus === "kicked") {
      const chatId = ctx.chat.id;
      revokeChat(chatId);
      log("bot", `Removed from chat ${chatId} — revoked userbot access`);
    }
  });

  // ── Message handlers (delegated to handlers.ts) ──────────────────────────
  bot.on("message:text", (ctx) => handleTextMessage(ctx, bot, config));
  bot.on("message:photo", (ctx) => handlePhotoMessage(ctx, bot, config));
  bot.on("message:document", (ctx) => handleDocumentMessage(ctx, bot, config));
  bot.on("message:voice", (ctx) => handleVoiceMessage(ctx, bot, config));
  bot.on("message:sticker", (ctx) => handleStickerMessage(ctx, bot, config));
  bot.on("message:video", (ctx) => handleVideoMessage(ctx, bot, config));
  bot.on("message:animation", (ctx) =>
    handleAnimationMessage(ctx, bot, config),
  );
  bot.on("message:audio", (ctx) => handleAudioMessage(ctx, bot, config));
  bot.on("message:video_note", (ctx) =>
    handleVideoNoteMessage(ctx, bot, config),
  );
}
