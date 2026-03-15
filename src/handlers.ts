/**
 * Message handlers extracted from index.ts.
 * Each handler processes a specific message type and delegates to processAndReply.
 */

import type { Bot, Context } from "grammy";
import type { TalonConfig } from "./config.js";
import {
  splitMessage,
  markdownToTelegramHtml,
  friendlyError,
} from "./telegram.js";
import {
  setBridgeContext,
  clearBridgeContext,
  getBridgeMessageCount,
} from "./bridge.js";
import { InputFile } from "grammy";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { handleMessage } from "./agent.js";
import { appendDailyLog } from "./daily-log.js";
import { getRecentBySenderId } from "./history.js";
import { recordMessageProcessed, recordError } from "./watchdog.js";
import { log, logError } from "./log.js";

// ── Shared utilities ─────────────────────────────────────────────────────────

export function shouldHandleInGroup(ctx: {
  chat: { type: string };
  me: { id: number; username?: string };
  message?: {
    text?: string;
    caption?: string;
    reply_to_message?: { from?: { id: number } };
  };
}): boolean {
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  if (!isGroup) return true;
  const text = ctx.message?.text || ctx.message?.caption || "";
  const botUser = ctx.me.username;
  const mentioned =
    botUser && text.toLowerCase().includes(`@${botUser.toLowerCase()}`);
  const repliedToBot = ctx.message?.reply_to_message?.from?.id === ctx.me.id;
  return !!(mentioned || repliedToBot);
}

export function getSenderName(
  from: { first_name?: string; last_name?: string } | undefined,
): string {
  return (
    [from?.first_name, from?.last_name].filter(Boolean).join(" ") || "User"
  );
}

export function getReplyContext(
  replyMsg:
    | {
        from?: { id: number; first_name?: string; last_name?: string };
        text?: string;
        caption?: string;
      }
    | undefined,
  botId: number,
): string {
  if (!replyMsg || replyMsg.from?.id === botId) return "";
  const text = replyMsg.text || replyMsg.caption || "";
  if (!text) return "";
  const author = [replyMsg.from?.first_name, replyMsg.from?.last_name]
    .filter(Boolean)
    .join(" ");
  return `[Replying to ${author}: "${text.slice(0, 500)}"]\n\n`;
}

export function getForwardContext(msg: {
  forward_origin?: {
    type: string;
    sender_user?: { first_name?: string; last_name?: string };
    sender_user_name?: string;
    chat?: { title?: string };
  };
}): string {
  const origin = msg.forward_origin;
  if (!origin) return "";
  let from = "someone";
  if (origin.type === "user" && origin.sender_user) {
    from = [origin.sender_user.first_name, origin.sender_user.last_name]
      .filter(Boolean)
      .join(" ");
  } else if (origin.type === "hidden_user" && origin.sender_user_name) {
    from = origin.sender_user_name;
  } else if (
    (origin.type === "channel" || origin.type === "chat") &&
    origin.chat
  ) {
    from = origin.chat.title || "a chat";
  }
  return `[Forwarded from ${from}]\n`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function downloadTelegramFile(
  bot: Bot,
  config: TalonConfig,
  fileId: string,
  fileName: string,
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Could not get file path from Telegram");

  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  const uploadsDir = resolve(config.workspace, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const destPath = resolve(uploadsDir, safeName);
  writeFileSync(destPath, buffer);
  return destPath;
}

// ── Message queue (debounce rapid-fire messages per chat) ─────────────────────

type QueuedMessage = {
  prompt: string;
  replyToId: number;
  messageId: number;
  senderName: string;
  senderUsername?: string;
  senderId?: number;
  isGroup: boolean;
};

const messageQueues = new Map<
  string,
  {
    messages: QueuedMessage[];
    timer: ReturnType<typeof setTimeout>;
    bot: Bot;
    config: TalonConfig;
    numericChatId: number;
    queuedReactionMsgIds: number[];
  }
>();

const DEBOUNCE_MS = 500;

/**
 * Enqueue a message for processing. If another message arrives within DEBOUNCE_MS,
 * they are concatenated and sent as a single query to avoid duplicate SDK spawns.
 * Queued messages get a hourglass reaction to indicate they've been seen.
 */
function enqueueMessage(
  bot: Bot,
  config: TalonConfig,
  chatId: string,
  numericChatId: number,
  msg: QueuedMessage,
): void {
  const existing = messageQueues.get(chatId);
  if (existing) {
    existing.messages.push(msg);
    // Show hourglass reaction on the queued message to indicate it's been seen
    bot.api
      .setMessageReaction(numericChatId, msg.messageId, [
        { type: "emoji", emoji: "\u23F3" as "\uD83D\uDC4D" },
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
  if (messages.length === 0) return;

  // Clear hourglass reactions on queued messages now that we're processing
  for (const msgId of queuedReactionMsgIds) {
    bot.api.setMessageReaction(numericChatId, msgId, []).catch(() => {});
  }

  // Use last message's metadata for reply context
  const last = messages[messages.length - 1];

  // Concatenate prompts (with newlines between them if multiple)
  const combinedPrompt =
    messages.length === 1
      ? messages[0].prompt
      : messages.map((m) => m.prompt).join("\n\n");

  const logSummary = combinedPrompt.slice(0, 80).replace(/\n/g, " ");
  appendDailyLog(last.senderName, logSummary);

  try {
    await processAndReply(
      bot,
      config,
      chatId,
      numericChatId,
      last.replyToId,
      last.messageId,
      combinedPrompt,
      last.senderName,
      last.isGroup,
      last.senderUsername,
      last.senderId,
    );
    recordMessageProcessed();
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    const chatType = last.isGroup ? "group" : "DM";
    const promptPreview = combinedPrompt.slice(0, 100).replace(/\n/g, " ");
    logError(
      "bot",
      `[${chatId}] [${chatType}] [${last.senderName}] Error: ${errObj.message} | prompt: "${promptPreview}"`,
    );
    recordError(errObj.message);

    // Retry once for transient errors
    if (isTransientError(errObj)) {
      log("bot", `[${chatId}] Retrying after transient error...`);
      try {
        await new Promise((r) => setTimeout(r, 2000));
        await processAndReply(
          bot,
          config,
          chatId,
          numericChatId,
          last.replyToId,
          last.messageId,
          combinedPrompt,
          last.senderName,
          last.isGroup,
          last.senderUsername,
          last.senderId,
        );
        return;
      } catch (retryErr) {
        const retryErrObj =
          retryErr instanceof Error ? retryErr : new Error(String(retryErr));
        logError(
          "bot",
          `[${chatId}] [${chatType}] Retry failed: ${retryErrObj.message}`,
        );
        await sendHtml(
          bot,
          numericChatId,
          escapeHtml(friendlyError(retryErrObj)),
          last.replyToId,
        );
        return;
      }
    }

    await sendHtml(
      bot,
      numericChatId,
      escapeHtml(friendlyError(errObj)),
      last.replyToId,
    );
  }
}

/** Check if an error is transient and worth retrying. */
function isTransientError(err: Error): boolean {
  const msg = err.message;
  // Transient: overloaded, network issues, 503, 429
  if (
    /overloaded|503|capacity|network|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(
      msg,
    )
  )
    return true;
  // Rate limit with short retry window
  if (/rate.?limit|429|too many requests/i.test(msg)) return true;
  return false;
}

// ── Response delivery ────────────────────────────────────────────────────────

async function sendHtml(
  bot: Bot,
  chatId: number,
  html: string,
  replyToId?: number,
): Promise<number> {
  const params = {
    parse_mode: "HTML" as const,
    reply_parameters: replyToId ? { message_id: replyToId } : undefined,
  };
  try {
    const sent = await bot.api.sendMessage(chatId, html, params);
    return sent.message_id;
  } catch {
    const plain = html.replace(/<[^>]+>/g, "");
    const sent = await bot.api.sendMessage(chatId, plain, {
      reply_parameters: replyToId ? { message_id: replyToId } : undefined,
    });
    return sent.message_id;
  }
}

/**
 * Run the agent and deliver responses with streaming + multi-message support.
 */
export async function processAndReply(
  bot: Bot,
  config: TalonConfig,
  chatId: string | number,
  numericChatId: number,
  replyToId: number,
  messageId: number,
  prompt: string,
  senderName: string,
  isGroup: boolean,
  senderUsername?: string,
  senderId?: number,
): Promise<void> {
  // Set bridge context so MCP tools can call Telegram actions in this chat
  setBridgeContext(numericChatId, bot, InputFile);

  // Auto-manage typing indicator: send immediately and keep alive every 4s
  await bot.api.sendChatAction(numericChatId, "typing").catch(() => {});
  const typingTimer = setInterval(() => {
    bot.api.sendChatAction(numericChatId, "typing").catch(() => {});
  }, 4000);

  let streamMsgId: number | undefined;
  let lastEditedText = "";
  let streamStarted = false;
  let isThinking = false;
  let hasTextStarted = false;

  const streamTimer = setTimeout(() => {
    streamStarted = true;
  }, 2000);

  const onStreamDelta = async (
    accumulated: string,
    phase?: "thinking" | "text",
  ) => {
    if (!streamStarted) return;
    try {
      // Track phase transitions
      if (phase === "thinking" && !isThinking) {
        isThinking = true;
        hasTextStarted = false;
      } else if (phase === "text" && !hasTextStarted) {
        hasTextStarted = true;
        isThinking = false;
      }

      // Choose cursor based on phase
      const cursor =
        isThinking && !hasTextStarted ? " \uD83D\uDCAD" : " \u258D";

      const display =
        accumulated.length > 3900
          ? accumulated.slice(0, 3900) + "\u2026"
          : accumulated;

      // During thinking phase with no text yet, show thinking indicator
      const displayText =
        isThinking && !hasTextStarted && !display.trim()
          ? "\uD83D\uDCAD thinking..."
          : display;

      if (!streamMsgId) {
        const content = displayText + cursor;
        const html = markdownToTelegramHtml(content);
        try {
          const sent = await bot.api.sendMessage(numericChatId, html, {
            parse_mode: "HTML",
            reply_parameters: { message_id: replyToId },
          });
          streamMsgId = sent.message_id;
        } catch {
          const sent = await bot.api.sendMessage(numericChatId, content, {
            reply_parameters: { message_id: replyToId },
          });
          streamMsgId = sent.message_id;
        }
        lastEditedText = displayText;
      } else if (
        displayText.length - lastEditedText.length >= 60 ||
        (hasTextStarted &&
          isThinking !== (lastEditedText === "\uD83D\uDCAD thinking..."))
      ) {
        const content = displayText + cursor;
        const html = markdownToTelegramHtml(content);
        try {
          await bot.api.editMessageText(numericChatId, streamMsgId, html, {
            parse_mode: "HTML",
          });
        } catch {
          try {
            await bot.api.editMessageText(numericChatId, streamMsgId, content);
          } catch {
            // Rate limited, skip
          }
        }
        lastEditedText = displayText;
      }
    } catch {
      // Non-critical
    }
  };

  // Multi-message: send intermediate text blocks immediately
  const onTextBlock = async (text: string) => {
    if (streamMsgId) {
      const html = markdownToTelegramHtml(text);
      try {
        await bot.api.editMessageText(numericChatId, streamMsgId, html, {
          parse_mode: "HTML",
        });
      } catch {
        try {
          await bot.api.editMessageText(numericChatId, streamMsgId, text);
        } catch {
          // ignore
        }
      }
      streamMsgId = undefined;
      lastEditedText = "";
    } else {
      await sendHtml(
        bot,
        numericChatId,
        markdownToTelegramHtml(text),
        replyToId,
      );
    }
  };

  // In DMs, prepend user metadata so Claude knows who it's talking to
  // In groups, include sender's recent messages for conversation threading
  let enrichedPrompt = prompt;
  if (!isGroup && senderName) {
    const userTag = senderUsername ? ` (@${senderUsername})` : "";
    enrichedPrompt = `[DM from ${senderName}${userTag}]\n${prompt}`;
  } else if (isGroup && senderId) {
    // Pull the sender's last 5 messages for conversation continuity in groups
    const recentMsgs = getRecentBySenderId(String(chatId), senderId, 5);
    if (recentMsgs.length > 1) {
      // Exclude the current message (last one) since it's already in the prompt
      const priorMsgs = recentMsgs.slice(0, -1);
      if (priorMsgs.length > 0) {
        const contextLines = priorMsgs
          .map(
            (m) =>
              `  [${new Date(m.timestamp).toISOString().slice(11, 16)}] ${m.text.slice(0, 200)}`,
          )
          .join("\n");
        enrichedPrompt = `[${senderName}'s recent messages in this group:\n${contextLines}]\n\n${prompt}`;
      }
    }
  }

  const result = await handleMessage({
    chatId: String(chatId),
    text: enrichedPrompt,
    senderName,
    isGroup,
    messageId,
    onTextBlock,
    onStreamDelta,
  });

  clearTimeout(streamTimer);
  clearInterval(typingTimer);

  const bridgeSent = getBridgeMessageCount();

  if (bridgeSent === 0) {
    const finalText = result.text;
    if (finalText) {
      if (streamMsgId) {
        const chunks = splitMessage(finalText, config.maxMessageLength);
        const firstHtml = markdownToTelegramHtml(chunks[0]);
        try {
          await bot.api.editMessageText(numericChatId, streamMsgId, firstHtml, {
            parse_mode: "HTML",
          });
        } catch {
          try {
            await bot.api.editMessageText(
              numericChatId,
              streamMsgId,
              chunks[0],
            );
          } catch {
            // ignore
          }
        }
        for (let i = 1; i < chunks.length; i++) {
          await sendHtml(
            bot,
            numericChatId,
            markdownToTelegramHtml(chunks[i]),
            replyToId,
          );
        }
      } else {
        const chunks = splitMessage(finalText, config.maxMessageLength);
        for (const chunk of chunks) {
          await sendHtml(
            bot,
            numericChatId,
            markdownToTelegramHtml(chunk),
            replyToId,
          );
        }
      }
    }
    // No "(no response)" fallback — if Claude used tools or had nothing to say, silence is fine.
  } else if (streamMsgId) {
    try {
      await bot.api.deleteMessage(numericChatId, streamMsgId);
    } catch {
      // ignore
    }
  }

  clearBridgeContext();
}

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

    const fwdCtx = getForwardContext(
      ctx.message as Parameters<typeof getForwardContext>[0],
    );
    const replyCtx = getReplyContext(
      ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
      ctx.me.id,
    );

    const promptParts = [
      fwdCtx,
      replyCtx,
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
    });
  } catch (err) {
    logError(
      "bot",
      `[${chatId}] ${media.type} error (${sender}): ${err instanceof Error ? err.message : err}`,
    );
    await sendHtml(
      bot,
      ctx.chat.id,
      escapeHtml(
        friendlyError(err instanceof Error ? err : new Error(String(err))),
      ),
      ctx.message.message_id,
    );
  }
}

// ── Message handlers ─────────────────────────────────────────────────────────

export async function handleTextMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx as never)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  const replyCtx = getReplyContext(
    ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
    ctx.me.id,
  );
  const fwdCtx = getForwardContext(
    ctx.message as Parameters<typeof getForwardContext>[0],
  );
  const prompt = fwdCtx + replyCtx + (ctx.message.text ?? "");

  enqueueMessage(bot, config, chatId, ctx.chat.id, {
    prompt,
    replyToId: ctx.message.message_id,
    messageId: ctx.message.message_id,
    senderName: sender,
    senderUsername,
    senderId: ctx.from?.id,
    isGroup,
  });
}

export async function handlePhotoMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx as never)) return;

  const photos = (ctx.message as unknown as Record<string, unknown>)
    .photo as Array<{ file_id: string; file_unique_id: string }>;
  if (!photos) return;
  const bestPhoto = photos[photos.length - 1];
  const caption =
    ((ctx.message as unknown as Record<string, unknown>).caption as string) ||
    "";

  // Determine extension from Telegram's file path if available
  const photoFile = await bot.api.getFile(bestPhoto.file_id).catch(() => null);
  const ext = photoFile?.file_path?.split(".").pop() ?? "jpg";

  await handleMediaMessage(ctx, bot, config, {
    type: "photo",
    fileId: bestPhoto.file_id,
    fileName: `photo_${bestPhoto.file_unique_id}.${ext}`,
    promptLines: [
      "User sent a photo saved to: ${savedPath}",
      "Read and analyze this image using the Read tool — you can view images directly.",
    ],
    caption,
  });
}

export async function handleDocumentMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx as never)) return;

  const doc = (ctx.message as unknown as Record<string, unknown>).document as {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    file_size?: number;
    mime_type?: string;
  };
  if (!doc) return;

  const fileName = doc.file_name || `doc_${doc.file_unique_id}`;
  const caption =
    ((ctx.message as unknown as Record<string, unknown>).caption as string) ||
    "";

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
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx as never)) return;

  const voice = (ctx.message as unknown as Record<string, unknown>).voice as {
    file_id: string;
    file_unique_id: string;
    duration: number;
  };
  if (!voice) return;

  await handleMediaMessage(ctx, bot, config, {
    type: "voice",
    fileId: voice.file_id,
    fileName: `voice_${voice.file_unique_id}.ogg`,
    promptLines: [
      `User sent a voice message (${voice.duration}s).`,
      "Audio file saved to: ${savedPath}",
    ],
  });
}

export async function handleStickerMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx as never)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  const sticker = (ctx.message as unknown as Record<string, unknown>)
    .sticker as {
    file_id: string;
    emoji?: string;
    set_name?: string;
    is_animated?: boolean;
    is_video?: boolean;
  };
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
  });
}

export async function handleVideoMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx as never)) return;

  const video = (ctx.message as unknown as Record<string, unknown>).video as {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    duration: number;
    width: number;
    height: number;
  };
  if (!video) return;

  const fileName = video.file_name || `video_${video.file_unique_id}.mp4`;
  const caption =
    ((ctx.message as unknown as Record<string, unknown>).caption as string) ||
    "";

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
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx as never)) return;

  const anim = (ctx.message as unknown as Record<string, unknown>)
    .animation as {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    duration: number;
  };
  if (!anim) return;

  const fileName = anim.file_name || `animation_${anim.file_unique_id}.mp4`;
  const caption =
    ((ctx.message as unknown as Record<string, unknown>).caption as string) ||
    "";

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

    appendDailyLog(sender, `Button: ${callbackData}`);

    await processAndReply(
      bot,
      config,
      chatId,
      numericChatId,
      replyToId,
      replyToId,
      prompt,
      sender,
      isGroup,
    );
  } catch (err) {
    logError(
      "bot",
      `[${chatId}] Callback error (${sender}): ${err instanceof Error ? err.message : err}`,
    );
  }
}
