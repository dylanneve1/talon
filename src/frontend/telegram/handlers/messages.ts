/**
 * Per-message-type handlers — text, photo, document, voice, sticker, video,
 * animation, audio, video-note, and callback queries. Each validates access /
 * rate limits, builds a prompt, and enqueues (or runs the agent directly for
 * callback queries).
 */

import type { Bot, Context } from "grammy";
import type { TalonConfig } from "../../../util/config.js";
import { escapeHtml } from "../formatting.js";
import { friendlyMessage } from "../../../core/errors.js";
import { setMessageFilePath } from "../../../storage/history.js";
import { addMedia } from "../../../storage/media-index.js";
import { appendDailyLog } from "../../../storage/daily-log.js";
import { logError } from "../../../util/log.js";
import { recordMessageSignal } from "../../../core/soul/taps.js";
import {
  getSenderName,
  getReplyContext,
  getForwardContext,
  downloadReplyPhoto,
  downloadTelegramFile,
} from "./context.js";
import { shouldHandleInGroup, isAccessAllowed } from "./access.js";
import { enqueueMessage, isUserRateLimited } from "./queue.js";
import { processAndReply, sendHtml } from "./delivery.js";

// ── Shared media handler ──────────────────────────────────────────────────────

type MediaDescriptor = {
  /** Human-readable media type for prompt (e.g. "photo", "video", "voice message"). */
  type: string;
  /** File ID to download from Telegram. */
  fileId: string;
  /** File name for saving locally. */
  fileName: string;
  /** Extra prompt lines describing the media. */
  promptLines: string[];
  /** Caption from the message, if any. */
  caption?: string;
  /** Optional file size check (reject if too large). */
  fileSize?: number;
};

/**
 * Shared handler for all downloadable media types (photo, document, voice, video, animation).
 * Extracts forward/reply context, downloads the file, builds a prompt, and enqueues.
 */
async function handleMediaMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
  media: MediaDescriptor,
): Promise<void> {
  if (!ctx.message || !ctx.chat) return;
  if (ctx.from?.id && isUserRateLimited(ctx.from.id)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  try {
    // File size check
    if (media.fileSize && media.fileSize > 20 * 1024 * 1024) {
      await sendHtml(
        bot,
        ctx.chat.id,
        "File too large (max 20MB).",
        ctx.message.message_id,
      );
      return;
    }

    const savedPath = await downloadTelegramFile(
      bot,
      config,
      media.fileId,
      media.fileName,
    );

    // Store file path in history + media index
    setMessageFilePath(chatId, ctx.message.message_id, savedPath);
    addMedia({
      chatId,
      msgId: ctx.message.message_id,
      senderName: sender,
      type: media.type as
        | "photo"
        | "document"
        | "voice"
        | "video"
        | "animation"
        | "audio"
        | "sticker",
      filePath: savedPath,
      caption: media.caption,
      timestamp: Date.now(),
    });

    const fwdCtx = getForwardContext(
      ctx.message as Parameters<typeof getForwardContext>[0],
    );
    const replyCtx = getReplyContext(
      ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
      ctx.me.id,
      (ctx.message as { quote?: { text?: string; is_manual?: boolean } }).quote,
    );
    const replyPhotoCtx = await downloadReplyPhoto(
      ctx.message.reply_to_message as Parameters<typeof downloadReplyPhoto>[0],
      bot,
      config,
    );

    const promptParts = [
      fwdCtx,
      replyCtx,
      replyPhotoCtx,
      ...media.promptLines.map((l) => l.replace("${savedPath}", savedPath)),
      media.caption ? `Caption: ${media.caption}` : "",
    ].filter(Boolean);

    const prompt = promptParts.join("\n");

    enqueueMessage(bot, config, chatId, ctx.chat.id, {
      prompt,
      replyToId: ctx.message.message_id,
      messageId: ctx.message.message_id,
      senderName: sender,
      senderUsername,
      senderId: ctx.from?.id,
      isGroup,
      chatTitle: isGroup ? (ctx.chat as { title?: string }).title : undefined,
    });
  } catch (err) {
    logError(
      "bot",
      `[${chatId}] ${media.type} error (${sender}): ${err instanceof Error ? err.message : err}`,
    );
    await sendHtml(
      bot,
      ctx.chat.id,
      escapeHtml(friendlyMessage(err)),
      ctx.message.message_id,
    );
  }
}

// ── Text message handler ────────────────────────────────────────────────────

export async function handleTextMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;
  if (!(await isAccessAllowed(ctx, bot))) return;
  if (ctx.from?.id && isUserRateLimited(ctx.from.id)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  const replyCtx = getReplyContext(
    ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
    ctx.me.id,
    (ctx.message as { quote?: { text?: string; is_manual?: boolean } }).quote,
  );
  const replyPhotoCtx = await downloadReplyPhoto(
    ctx.message.reply_to_message as Parameters<typeof downloadReplyPhoto>[0],
    bot,
    config,
  );
  const fwdCtx = getForwardContext(
    ctx.message as Parameters<typeof getForwardContext>[0],
  );
  const prompt = fwdCtx + replyCtx + replyPhotoCtx + (ctx.message.text ?? "");

  // Soul tap: a message reaching here is addressed to Talon (DM, mention, or
  // reply). If it reads as a standing directive or a correction, record it as
  // evidence. No-op unless the soul is enabled.
  recordMessageSignal({
    text: ctx.message.text ?? "",
    actor: sender,
    addressedToBot: true,
  });

  enqueueMessage(bot, config, chatId, ctx.chat.id, {
    prompt,
    replyToId: ctx.message.message_id,
    messageId: ctx.message.message_id,
    senderName: sender,
    senderUsername,
    senderId: ctx.from?.id,
    isGroup,
    chatTitle: isGroup ? (ctx.chat as { title?: string }).title : undefined,
  });
}

export async function handlePhotoMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;
  if (!(await isAccessAllowed(ctx, bot))) return;

  const photos = ctx.message.photo;
  if (!photos?.length) return;
  const bestPhoto = photos[photos.length - 1];
  const caption = ctx.message.caption || "";

  await handleMediaMessage(ctx, bot, config, {
    type: "photo",
    fileId: bestPhoto.file_id,
    fileName: `photo_${bestPhoto.file_unique_id}.jpg`,
    promptLines: [
      "User sent a photo saved to: ${savedPath}",
      "Read this file to view it. If you need to reference this image in future turns, re-read the file — image data does not persist between turns.",
    ],
    caption,
  });
}

export async function handleDocumentMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;
  if (!(await isAccessAllowed(ctx, bot))) return;

  const doc = ctx.message.document;
  if (!doc) return;

  const fileName = doc.file_name || `doc_${doc.file_unique_id}`;
  const caption = ctx.message.caption || "";

  await handleMediaMessage(ctx, bot, config, {
    type: "document",
    fileId: doc.file_id,
    fileName,
    fileSize: doc.file_size,
    promptLines: [
      `User sent a document: "${fileName}" (${doc.mime_type || "unknown"}).`,
      "Saved to: ${savedPath}",
      "Read and process this file.",
    ],
    caption,
  });
}

export async function handleVoiceMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;
  if (!(await isAccessAllowed(ctx, bot))) return;

  const voice = ctx.message.voice;
  if (!voice) return;

  await handleMediaMessage(ctx, bot, config, {
    type: "voice",
    fileId: voice.file_id,
    fileName: `voice_${voice.file_unique_id}.ogg`,
    promptLines: [
      `User sent a voice message (${voice.duration}s).`,
      "Audio saved to: ${savedPath}. You cannot transcribe audio — acknowledge it and respond based on context.",
    ],
  });
}

export async function handleStickerMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;
  if (!(await isAccessAllowed(ctx, bot))) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  const sticker = ctx.message.sticker;
  if (!sticker) return;

  const emoji = sticker.emoji || "";
  const setName = sticker.set_name || "";

  const prompt = [
    `User sent a sticker: ${emoji}`,
    `Sticker file_id: ${sticker.file_id}`,
    setName ? `Sticker set: ${setName}` : "",
    sticker.is_animated
      ? "(animated)"
      : sticker.is_video
        ? "(video sticker)"
        : "",
    "You can send this sticker back using the send_sticker tool with the file_id above.",
  ]
    .filter(Boolean)
    .join("\n");

  enqueueMessage(bot, config, chatId, ctx.chat.id, {
    prompt,
    replyToId: ctx.message.message_id,
    messageId: ctx.message.message_id,
    senderName: sender,
    senderUsername,
    senderId: ctx.from?.id,
    isGroup,
    chatTitle: isGroup ? (ctx.chat as { title?: string }).title : undefined,
  });
}

export async function handleVideoMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;
  if (!(await isAccessAllowed(ctx, bot))) return;

  const video = ctx.message.video;
  if (!video) return;

  const fileName = video.file_name || `video_${video.file_unique_id}.mp4`;
  const caption = ctx.message.caption || "";

  await handleMediaMessage(ctx, bot, config, {
    type: "video",
    fileId: video.file_id,
    fileName,
    promptLines: [
      `User sent a video: "${fileName}" (${video.duration}s, ${video.width}x${video.height}).`,
      "Saved to: ${savedPath}",
    ],
    caption,
  });
}

export async function handleAnimationMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;
  if (!(await isAccessAllowed(ctx, bot))) return;

  const anim = ctx.message.animation;
  if (!anim) return;

  const fileName = anim.file_name || `animation_${anim.file_unique_id}.mp4`;
  const caption = ctx.message.caption || "";

  await handleMediaMessage(ctx, bot, config, {
    type: "animation",
    fileId: anim.file_id,
    fileName,
    promptLines: [
      `User sent a GIF/animation: "${fileName}" (${anim.duration}s).`,
      "Saved to: ${savedPath}",
    ],
    caption,
  });
}

export async function handleAudioMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;
  if (!(await isAccessAllowed(ctx, bot))) return;
  if (ctx.from?.id && isUserRateLimited(ctx.from.id)) return;

  const audio = ctx.message.audio;
  if (!audio) return;

  const title = audio.title || audio.file_name || "audio";
  const performer = audio.performer ? ` by ${audio.performer}` : "";
  const fileName = audio.file_name || `audio_${audio.file_unique_id}.mp3`;
  const caption = ctx.message.caption || "";

  await handleMediaMessage(ctx, bot, config, {
    type: "audio",
    fileId: audio.file_id,
    fileName,
    fileSize: audio.file_size,
    promptLines: [
      `User sent an audio file: "${title}"${performer} (${audio.duration}s).`,
      "Saved to: ${savedPath}",
    ],
    caption,
  });
}

export async function handleVideoNoteMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;
  if (!(await isAccessAllowed(ctx, bot))) return;
  if (ctx.from?.id && isUserRateLimited(ctx.from.id)) return;

  const videoNote = ctx.message.video_note;
  if (!videoNote) return;

  await handleMediaMessage(ctx, bot, config, {
    type: "video note",
    fileId: videoNote.file_id,
    fileName: `videonote_${videoNote.file_unique_id}.mp4`,
    fileSize: videoNote.file_size,
    promptLines: [
      `User sent a round video note (${videoNote.duration}s).`,
      "Saved to: ${savedPath}",
    ],
  });
}

export async function handleCallbackQuery(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.callbackQuery || !("data" in ctx.callbackQuery)) return;

  const chatId = String(ctx.chat?.id ?? ctx.from?.id);
  const numericChatId = ctx.chat?.id ?? ctx.from?.id ?? 0;
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const callbackData = ctx.callbackQuery.data;

  // Acknowledge the callback immediately
  await ctx.answerCallbackQuery().catch(() => {});

  try {
    const prompt = `[Button pressed] User clicked inline button with callback data: "${callbackData}"`;
    const replyToId = ctx.callbackQuery.message?.message_id ?? 0;

    const chatTitle = isGroup
      ? (ctx.chat as { title?: string })?.title
      : undefined;
    appendDailyLog(sender, `Button: ${callbackData}`, { chatTitle });

    await processAndReply({
      bot,
      config,
      chatId,
      numericChatId,
      replyToId,
      messageId: replyToId,
      prompt,
      senderName: sender,
      isGroup,
      chatTitle,
    });
  } catch (err) {
    logError(
      "bot",
      `[${chatId}] Callback error (${sender}): ${err instanceof Error ? err.message : err}`,
    );
  }
}
