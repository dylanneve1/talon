/**
 * Message handlers extracted from index.ts.
 * Each handler processes a specific message type and delegates to processAndReply.
 */

import type { Bot, Context } from "grammy";
import type { TalonConfig } from "../../util/config.js";
import {
  splitMessage,
  markdownToTelegramHtml,
  escapeHtml,
} from "./formatting.js";
import { execute } from "../../core/dispatcher.js";
import { classify, friendlyMessage } from "../../core/errors.js";
import {
  enrichDMPrompt,
  enrichGroupPrompt,
} from "../../core/prompt-builder.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { appendDailyLog } from "../../storage/daily-log.js";
import { recordMessageProcessed, recordError } from "../../util/watchdog.js";
import { log, logError, logWarn } from "../../util/log.js";

// ── First-time DM user tracking ──────────────────────────────────────────────

const knownDmUsers = new Set<number>();
const KNOWN_DM_USERS_CAP = 10_000;

function trackDmUser(
  senderId: number,
  senderName: string,
  senderUsername?: string,
): void {
  if (knownDmUsers.has(senderId)) return;
  // Evict oldest 10% when cap reached (Set maintains insertion order)
  if (knownDmUsers.size >= KNOWN_DM_USERS_CAP) {
    const evictCount = Math.floor(KNOWN_DM_USERS_CAP * 0.1);
    const iter = knownDmUsers.values();
    for (let i = 0; i < evictCount; i++) {
      const val = iter.next();
      if (val.done) break;
      knownDmUsers.delete(val.value);
    }
  }
  knownDmUsers.add(senderId);
  const tag = senderUsername ? ` (@${senderUsername})` : "";
  log("users", `New DM user: ${senderName}${tag} [id:${senderId}]`);
  appendDailyLog("System", `New DM user: ${senderName}${tag} [id:${senderId}]`);
}

// ── Shared utilities ─────────────────────────────────────────────────────────

export function shouldHandleInGroup(ctx: Context): boolean {
  if (!ctx.chat || !ctx.message) return false;
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  if (!isGroup) return true;
  const text = ctx.message.text || ctx.message.caption || "";
  const botUser = ctx.me.username;
  const mentioned =
    botUser && text.toLowerCase().includes(`@${botUser.toLowerCase()}`);
  const repliedToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
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

  // Guard against excessively large files (50MB limit)
  const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
  const contentLength = resp.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
    throw new Error(`File too large (${Math.round(parseInt(contentLength, 10) / 1024 / 1024)}MB, max 50MB)`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  const uploadsDir = resolve(config.workspace, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const destPath = resolve(uploadsDir, safeName);
  // Prevent path traversal — ensure resolved path stays within uploads dir
  if (!destPath.startsWith(resolve(uploadsDir))) {
    throw new Error("Invalid file name");
  }
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
const MAX_QUEUED_PER_CHAT = 20;

// ── Per-user rate limiting ──────────────────────────────────────────────────

const userMessageTimestamps = new Map<number, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
const RATE_LIMIT_MAX_MESSAGES = 15; // max 15 messages per minute per user

function isUserRateLimited(senderId: number): boolean {
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
function enqueueMessage(
  bot: Bot,
  config: TalonConfig,
  chatId: string,
  numericChatId: number,
  msg: QueuedMessage,
): void {
  const existing = messageQueues.get(chatId);
  if (existing) {
    if (existing.messages.length >= MAX_QUEUED_PER_CHAT) return; // drop excess
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
    bot.api.setMessageReaction(numericChatId, msgId, []).catch((err) => {
      logWarn("bot", `Failed to clear reaction on msg ${msgId}: ${err instanceof Error ? err.message : err}`);
    });
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
    await processAndReply({
      bot, config, chatId, numericChatId,
      replyToId: last.replyToId,
      messageId: last.messageId,
      prompt: combinedPrompt,
      senderName: last.senderName,
      isGroup: last.isGroup,
      senderUsername: last.senderUsername,
      senderId: last.senderId,
    });
    recordMessageProcessed();
  } catch (err) {
    const classified = classify(err);
    const chatType = last.isGroup ? "group" : "DM";
    const promptPreview = combinedPrompt.slice(0, 100).replace(/\n/g, " ");
    logError(
      "bot",
      `[${chatId}] [${chatType}] [${last.senderName}] ${classified.reason}: ${classified.message} | prompt: "${promptPreview}"`,
    );
    recordError(classified.message);

    // Retry once for transient errors (rate_limit, overloaded, network)
    if (classified.retryable) {
      const delayMs = classified.retryAfterMs ?? 2000;
      log("bot", `[${chatId}] Retrying after ${classified.reason} (${delayMs}ms)...`);
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        await processAndReply({
          bot, config, chatId, numericChatId,
          replyToId: last.replyToId,
          messageId: last.messageId,
          prompt: combinedPrompt,
          senderName: last.senderName,
          isGroup: last.isGroup,
          senderUsername: last.senderUsername,
          senderId: last.senderId,
        });
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
  } catch (err) {
    logWarn("bot", `HTML send failed, falling back to plain text: ${err instanceof Error ? err.message : err}`);
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
type ProcessAndReplyParams = {
  bot: Bot;
  config: TalonConfig;
  chatId: string | number;
  numericChatId: number;
  replyToId: number;
  messageId: number;
  prompt: string;
  senderName: string;
  isGroup: boolean;
  senderUsername?: string;
  senderId?: number;
};

// ── Streaming state for Telegram message edits ──────────────────────────────

type StreamState = {
  msgId: number | undefined;
  lastEditedText: string;
  started: boolean;
  isThinking: boolean;
  hasTextStarted: boolean;
  editing: boolean; // mutex: prevents concurrent edits to same message
};

function createStreamCallbacks(
  bot: Bot,
  chatId: number,
  replyToId: number,
  state: StreamState,
) {
  const onStreamDelta = async (
    accumulated: string,
    phase?: "thinking" | "text",
  ) => {
    if (!state.started || state.editing) return;
    state.editing = true;
    try {
      if (phase === "thinking" && !state.isThinking) {
        state.isThinking = true;
        state.hasTextStarted = false;
      } else if (phase === "text" && !state.hasTextStarted) {
        state.hasTextStarted = true;
        state.isThinking = false;
      }

      const cursor =
        state.isThinking && !state.hasTextStarted ? " \uD83D\uDCAD" : " \u258D";
      const display =
        accumulated.length > 3900
          ? accumulated.slice(0, 3900) + "\u2026"
          : accumulated;
      const displayText =
        state.isThinking && !state.hasTextStarted && !display.trim()
          ? "\uD83D\uDCAD thinking..."
          : display;

      const wasThinking = state.lastEditedText === "\uD83D\uDCAD thinking...";
      const transitionToText = wasThinking && state.hasTextStarted;

      if (!state.msgId) {
        const content = displayText + cursor;
        const html = markdownToTelegramHtml(content);
        try {
          const sent = await bot.api.sendMessage(chatId, html, {
            parse_mode: "HTML",
            reply_parameters: { message_id: replyToId },
          });
          state.msgId = sent.message_id;
        } catch {
          const sent = await bot.api.sendMessage(chatId, content, {
            reply_parameters: { message_id: replyToId },
          });
          state.msgId = sent.message_id;
        }
        state.lastEditedText = displayText;
      } else if (
        transitionToText ||
        displayText.length - state.lastEditedText.length >= 60
      ) {
        const content = displayText + cursor;
        const html = markdownToTelegramHtml(content);
        try {
          await bot.api.editMessageText(chatId, state.msgId, html, {
            parse_mode: "HTML",
          });
        } catch {
          try {
            await bot.api.editMessageText(chatId, state.msgId, content);
          } catch (e) {
            logWarn("bot", `Stream edit failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        state.lastEditedText = displayText;
      }
    } catch (err) {
      logWarn("bot", `Stream delta error: ${err instanceof Error ? err.message : err}`);
    } finally {
      state.editing = false;
    }
  };

  const onTextBlock = async (text: string) => {
    state.editing = true;
    try {
    if (state.msgId) {
      const html = markdownToTelegramHtml(text);
      try {
        await bot.api.editMessageText(chatId, state.msgId, html, {
          parse_mode: "HTML",
        });
      } catch {
        try {
          await bot.api.editMessageText(chatId, state.msgId, text);
        } catch (e) {
          logWarn("bot", `Text block edit failed: ${e instanceof Error ? e.message : e}`);
        }
      }
      state.msgId = undefined;
      state.lastEditedText = "";
    } else {
      await sendHtml(bot, chatId, markdownToTelegramHtml(text), replyToId);
    }
    } finally {
      state.editing = false;
    }
  };

  return { onStreamDelta, onTextBlock };
}

async function deliverFinalText(
  bot: Bot,
  chatId: number,
  text: string,
  replyToId: number,
  maxLen: number,
  streamMsgId?: number,
): Promise<void> {
  const chunks = splitMessage(text, maxLen);
  if (streamMsgId) {
    // Edit the stream message with final content, send overflow as new messages
    const firstHtml = markdownToTelegramHtml(chunks[0]);
    try {
      await bot.api.editMessageText(chatId, streamMsgId, firstHtml, {
        parse_mode: "HTML",
      });
    } catch {
      try {
        await bot.api.editMessageText(chatId, streamMsgId, chunks[0]);
      } catch (e) {
        logWarn("bot", `Final edit failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    for (let i = 1; i < chunks.length; i++) {
      await sendHtml(bot, chatId, markdownToTelegramHtml(chunks[i]), replyToId);
    }
  } else {
    for (const chunk of chunks) {
      await sendHtml(bot, chatId, markdownToTelegramHtml(chunk), replyToId);
    }
  }
}

export async function processAndReply(params: ProcessAndReplyParams): Promise<void> {
  const {
    bot, config, chatId, numericChatId, replyToId, messageId,
    prompt, senderName, isGroup, senderUsername, senderId,
  } = params;

  const stream: StreamState = {
    msgId: undefined,
    lastEditedText: "",
    started: false,
    isThinking: false,
    hasTextStarted: false,
    editing: false,
  };
  const streamTimer = setTimeout(() => { stream.started = true; }, 2000);

  try {
    const { onStreamDelta, onTextBlock } = createStreamCallbacks(
      bot, numericChatId, replyToId, stream,
    );

    // Enrich prompt with sender context
    let enrichedPrompt = prompt;
    if (!isGroup && senderName) {
      enrichedPrompt = enrichDMPrompt(prompt, senderName, senderUsername);
      if (senderId) trackDmUser(senderId, senderName, senderUsername);
    } else if (isGroup && senderId) {
      enrichedPrompt = enrichGroupPrompt(prompt, String(chatId), senderId);
    }

    const result = await execute({
      chatId: String(chatId),
      numericChatId,
      prompt: enrichedPrompt,
      senderName,
      isGroup,
      messageId,
      source: "message",
      onStreamDelta,
      onTextBlock,
    });

    // Deliver final response
    if (result.bridgeMessageCount === 0 && result.text) {
      await deliverFinalText(
        bot, numericChatId, result.text, replyToId,
        config.maxMessageLength, stream.msgId,
      );
    } else if (stream.msgId) {
      await bot.api.deleteMessage(numericChatId, stream.msgId).catch((err) => {
        logWarn("bot", `Failed to delete stream msg: ${err instanceof Error ? err.message : err}`);
      });
    }
  } finally {
    clearTimeout(streamTimer);
  }
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
      escapeHtml(friendlyMessage(err)),
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
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;
  if (ctx.from?.id && isUserRateLimited(ctx.from.id)) return;

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
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;

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
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;

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

  const voice = ctx.message.voice;
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
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;

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
  });
}

export async function handleVideoMessage(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  if (!ctx.message || !ctx.chat || !shouldHandleInGroup(ctx)) return;

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

    appendDailyLog(sender, `Button: ${callbackData}`);

    await processAndReply({
      bot, config, chatId, numericChatId,
      replyToId,
      messageId: replyToId,
      prompt,
      senderName: sender,
      isGroup,
    });
  } catch (err) {
    logError(
      "bot",
      `[${chatId}] Callback error (${sender}): ${err instanceof Error ? err.message : err}`,
    );
  }
}
