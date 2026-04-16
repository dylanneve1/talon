/**
 * Message handlers extracted from index.ts.
 * Each handler processes a specific message type and delegates to processAndReply.
 */

import type { Bot, Context } from "grammy";
import type { TalonConfig } from "../../util/config.js";
import { markdownToTelegramHtml, escapeHtml } from "./formatting.js";
import { execute } from "../../core/dispatcher.js";
import { classify, friendlyMessage } from "../../core/errors.js";
import {
  enrichDMPrompt,
  enrichGroupPrompt,
} from "../../core/prompt-builder.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  appendDailyLog,
  appendDailyLogResponse,
} from "../../storage/daily-log.js";
import { setMessageFilePath } from "../../storage/history.js";
import { addMedia } from "../../storage/media-index.js";
import { recordMessageProcessed, recordError } from "../../util/watchdog.js";
import { log, logError, logWarn, logDebug } from "../../util/log.js";

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
      knownDmUsers.delete(iter.next().value as number);
    }
  }
  knownDmUsers.add(senderId);
  const tag = senderUsername ? ` (@${senderUsername})` : "";
  log("users", `New DM user: ${senderName}${tag} [id:${senderId}]`);
  appendDailyLog("System", `New DM user: ${senderName}${tag} [id:${senderId}]`);
}

// ── Access control ──────────────────────────────────────────────────────────

let allowedUserIds: Set<number> | null = null; // null = no whitelist (allow all)
let adminId = 0;
// chatId → { isMember, expiresAt } — timestamp-based expiry, no timers
const verifiedGroups = new Map<
  number,
  { isMember: boolean; expiresAt: number }
>();
const MAX_VERIFIED_GROUPS = 1000;
const VERIFIED_GROUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function setAccessControl(cfg: {
  allowedUsers?: number[];
  adminUserId?: number;
}): void {
  allowedUserIds = cfg.allowedUsers?.length ? new Set(cfg.allowedUsers) : null;
  adminId = cfg.adminUserId ?? 0;
}

/**
 * Check if a DM user is allowed. Returns true if no whitelist is set.
 */
function isDmAllowed(senderId: number | undefined): boolean {
  if (!allowedUserIds) return true;
  return senderId !== undefined && allowedUserIds.has(senderId);
}

/**
 * Check if the admin is a member of a group. Caches results for 10 minutes.
 */
async function isAdminInGroup(bot: Bot, chatId: number): Promise<boolean> {
  if (!adminId) return true; // no admin configured, allow all groups
  const cached = verifiedGroups.get(chatId);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.isMember;
  }
  // Expired or missing — delete stale entry
  if (cached) verifiedGroups.delete(chatId);

  // Prevent unbounded growth — evict expired entries first, then clear if still over
  if (verifiedGroups.size >= MAX_VERIFIED_GROUPS) {
    const now = Date.now();
    for (const [k, v] of verifiedGroups) {
      if (v.expiresAt <= now) verifiedGroups.delete(k);
    }
    if (verifiedGroups.size >= MAX_VERIFIED_GROUPS) verifiedGroups.clear();
  }

  try {
    const member = await bot.api.getChatMember(chatId, adminId);
    const isMember = !["left", "kicked"].includes(member.status);
    verifiedGroups.set(chatId, {
      isMember,
      expiresAt: Date.now() + VERIFIED_GROUP_TTL_MS,
    });
    return isMember;
  } catch (err) {
    logWarn(
      "bot",
      `isAdminInGroup check failed for chat ${chatId}: ${err instanceof Error ? err.message : err}`,
    );
    // API error (e.g. bot can't query members) — deny by default
    verifiedGroups.set(chatId, {
      isMember: false,
      expiresAt: Date.now() + VERIFIED_GROUP_TTL_MS,
    });
    return false;
  }
}

// ── Shared utilities ─────────────────────────────────────────────────────────

export function shouldHandleInGroup(ctx: Context): boolean {
  if (!ctx.chat || !ctx.message) return false;
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  if (!isGroup) return true;
  const text = ctx.message.text || ctx.message.caption || "";
  const botUser = ctx.me.username;
  // Word-boundary match — @botname must not be followed by alphanumeric/underscore
  const mentioned =
    botUser && new RegExp(`@${botUser}(?![a-zA-Z0-9_])`, "i").test(text);
  const repliedToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
  return !!(mentioned || repliedToBot);
}

// Rate-limit unauthorized access warnings (one per user/group per 10 minutes)
const unauthorizedCooldown = new Map<string, number>();
const UNAUTHORIZED_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_UNAUTHORIZED_COOLDOWNS = 5000;

/**
 * Full access check: DM whitelist + group admin membership.
 * Returns true if the message should be processed.
 * Warns unauthorized users and notifies the admin.
 */
export async function isAccessAllowed(
  ctx: Context,
  bot: Bot,
): Promise<boolean> {
  if (!ctx.chat) return false;
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";

  if (!isGroup) {
    if (isDmAllowed(ctx.from?.id)) return true;
    await notifyUnauthorized(bot, ctx, "dm");
    return false;
  }

  if (await isAdminInGroup(bot, ctx.chat.id)) return true;
  await notifyUnauthorized(bot, ctx, "group");
  return false;
}

async function notifyUnauthorized(
  bot: Bot,
  ctx: Context,
  type: "dm" | "group",
): Promise<void> {
  const key = type === "dm" ? `dm:${ctx.from?.id}` : `group:${ctx.chat?.id}`;
  const now = Date.now();
  const lastWarned = unauthorizedCooldown.get(key);
  if (lastWarned && now - lastWarned < UNAUTHORIZED_COOLDOWN_MS) return;
  if (unauthorizedCooldown.size >= MAX_UNAUTHORIZED_COOLDOWNS) {
    unauthorizedCooldown.clear();
  }
  unauthorizedCooldown.set(key, now);

  const sender = getSenderName(ctx.from);
  const username = ctx.from?.username ? ` (@${ctx.from.username})` : "";
  const userId = ctx.from?.id ?? "unknown";

  // Warn the user
  try {
    await bot.api.sendMessage(
      ctx.chat!.id,
      "⚠️ Unauthorized access. This bot is private. This attempt has been reported to the bot owner.",
    );
  } catch {
    /* can't send — ignore */
  }

  // Notify admin
  if (adminId) {
    const detail =
      type === "dm"
        ? `🚨 Unauthorized DM from ${sender}${username} [id:${userId}]`
        : `🚨 Unauthorized group access: "${(ctx.chat as { title?: string })?.title ?? ctx.chat!.id}" [id:${ctx.chat!.id}] by ${sender}${username}`;
    try {
      await bot.api.sendMessage(adminId, detail);
    } catch {
      /* admin unreachable — ignore */
    }
  }

  logWarn(
    "access",
    `Unauthorized ${type}: ${sender}${username} [id:${userId}] in chat ${ctx.chat!.id}`,
  );
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
        message_id?: number;
        from?: { id: number; first_name?: string; last_name?: string };
        text?: string;
        caption?: string;
        photo?: unknown[];
        document?: unknown;
        video?: unknown;
        voice?: unknown;
        audio?: unknown;
        sticker?: unknown;
        animation?: unknown;
      }
    | undefined,
  botId: number,
): string {
  if (!replyMsg) return "";

  const author =
    replyMsg.from?.id === botId
      ? "bot"
      : [replyMsg.from?.first_name, replyMsg.from?.last_name]
          .filter(Boolean)
          .join(" ") || "User";
  const text = replyMsg.text || replyMsg.caption || "";
  const msgIdTag = replyMsg.message_id ? ` msg_id:${replyMsg.message_id}` : "";

  // Detect media type
  const mediaType = replyMsg.photo
    ? "photo"
    : replyMsg.video
      ? "video"
      : replyMsg.document
        ? "document"
        : replyMsg.voice
          ? "voice"
          : replyMsg.audio
            ? "audio"
            : replyMsg.sticker
              ? "sticker"
              : replyMsg.animation
                ? "animation"
                : null;
  const mediaPart = mediaType ? ` [${mediaType}]` : "";

  // Build context — always include if there's a message_id (even if no text)
  const textPart = text ? `: "${text.slice(0, 500)}"` : "";

  if (!textPart && !mediaPart && !msgIdTag) return "";

  return `[Replying to ${author}${textPart}${mediaPart}${msgIdTag}]\n\n`;
}

/**
 * If the replied-to message contains a photo, download it and return a prompt
 * line pointing to the saved file so the model can see it. Returns "" if no photo.
 */
async function downloadReplyPhoto(
  replyMsg:
    | {
        photo?: {
          file_id: string;
          file_unique_id: string;
          width?: number;
          height?: number;
        }[];
      }
    | undefined,
  bot: Bot,
  config: TalonConfig,
): Promise<string> {
  if (!replyMsg?.photo?.length) return "";
  try {
    // Pick the largest photo size (last in array)
    const bestPhoto = replyMsg.photo[replyMsg.photo.length - 1];
    const savedPath = await downloadTelegramFile(
      bot,
      config,
      bestPhoto.file_id,
      `reply_photo_${bestPhoto.file_unique_id}.jpg`,
    );
    return `[Replied-to message contains a photo saved to: ${savedPath} — read it to view]\n`;
  } catch (err) {
    logWarn(
      "bot",
      `Failed to download reply photo: ${err instanceof Error ? err.message : err}`,
    );
    return "";
  }
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

async function downloadTelegramFile(
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
    throw new Error(
      `File too large (${Math.round(parseInt(contentLength, 10) / 1024 / 1024)}MB, max 50MB)`,
    );
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length === 0)
    throw new Error("Downloaded file is empty (0 bytes)");

  // Validate image files — prevent saving HTML/garbage as .jpg/.png
  // (corrupt "images" poison the session permanently on resume)
  const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
  const isImageExt = imageExts.some((ext) =>
    fileName.toLowerCase().endsWith(ext),
  );
  if (isImageExt) {
    const m = buffer.subarray(0, 16);
    const validImage =
      (m[0] === 0xff && m[1] === 0xd8) || // JPEG
      (m[0] === 0x89 && m[1] === 0x50 && m[2] === 0x4e && m[3] === 0x47) || // PNG
      (m[0] === 0x47 && m[1] === 0x49 && m[2] === 0x46) || // GIF
      (m[0] === 0x52 &&
        m[1] === 0x49 &&
        m[2] === 0x46 &&
        m[3] === 0x46 &&
        m[8] === 0x57 &&
        m[9] === 0x45 &&
        m[10] === 0x42 &&
        m[11] === 0x50); // WebP
    if (!validImage) {
      throw new Error(
        `File "${fileName}" has image extension but invalid content — not saving to prevent session corruption`,
      );
    }
  }

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
  chatTitle?: string;
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
        {
          type: "emoji",
          emoji: "\u23F3" as "\uD83D\uDC4D" /* grammY wants union type */,
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
      logWarn(
        "bot",
        `Failed to clear reaction on msg ${msgId}: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  // Use last message's metadata for reply context
  const last = messages[messages.length - 1];

  // Concatenate prompts (with newlines between them if multiple)
  const combinedPrompt =
    messages.length === 1
      ? messages[0].prompt
      : messages.map((m) => m.prompt).join("\n\n");

  const chatContext = {
    chatTitle: last.chatTitle,
    username: last.senderUsername,
  };
  appendDailyLog(last.senderName, combinedPrompt, chatContext);

  try {
    await processAndReply({
      bot,
      config,
      chatId,
      numericChatId,
      replyToId: last.replyToId,
      messageId: last.messageId,
      prompt: combinedPrompt,
      senderName: last.senderName,
      isGroup: last.isGroup,
      senderUsername: last.senderUsername,
      senderId: last.senderId,
      chatTitle: last.chatTitle,
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
      log(
        "bot",
        `[${chatId}] Retrying after ${classified.reason} (${delayMs}ms)...`,
      );
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        await processAndReply({
          bot,
          config,
          chatId,
          numericChatId,
          replyToId: last.replyToId,
          messageId: last.messageId,
          prompt: combinedPrompt,
          senderName: last.senderName,
          isGroup: last.isGroup,
          senderUsername: last.senderUsername,
          senderId: last.senderId,
          chatTitle: last.chatTitle,
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
    logWarn(
      "bot",
      `HTML send failed, falling back to plain text: ${err instanceof Error ? err.message : err}`,
    );
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
  chatTitle?: string;
};

// ── Streaming state for Telegram message edits ──────────────────────────────

type StreamState = {
  draftId: number;
  lastSentLength: number;
  started: boolean;
  editing: boolean;
  sentTextBlock: boolean;
};

// Probe once at startup whether sendMessageDraft is supported
let draftsSupported: boolean | null = null;

function createStreamCallbacks(
  bot: Bot,
  chatId: number,
  _replyToId: number,
  state: StreamState,
) {
  const onStreamDelta = async (
    accumulated: string,
    _phase?: "thinking" | "text",
  ) => {
    // Skip if drafts not supported or not ready
    if (draftsSupported === false || !state.started || state.editing) return;
    if (accumulated.length - state.lastSentLength < 40) return;

    state.editing = true;
    try {
      const display =
        accumulated.length > 3900
          ? accumulated.slice(0, 3900) + "\u2026"
          : accumulated;

      await bot.api.sendMessageDraft(chatId, state.draftId, display);
      if (draftsSupported === null) draftsSupported = true;
      state.lastSentLength = accumulated.length;
    } catch {
      // If first attempt fails, disable drafts entirely
      if (draftsSupported === null) {
        draftsSupported = false;
        logWarn("bot", "sendMessageDraft not supported — streaming disabled");
      }
    } finally {
      state.editing = false;
    }
  };

  const onTextBlock = async (text: string) => {
    await sendHtml(bot, chatId, markdownToTelegramHtml(text), _replyToId);
    state.lastSentLength = 0;
    state.sentTextBlock = true;
  };

  return { onStreamDelta, onTextBlock };
}

async function processAndReply(params: ProcessAndReplyParams): Promise<void> {
  const {
    bot,
    config,
    chatId,
    numericChatId,
    replyToId,
    messageId,
    prompt,
    senderName,
    isGroup,
    senderUsername,
    senderId,
    chatTitle,
  } = params;

  const stream: StreamState = {
    draftId: crypto.getRandomValues(new Uint32Array(1))[0] || 1,
    lastSentLength: 0,
    started: false,
    editing: false,
    sentTextBlock: false,
  };
  // Wait 1s before starting streaming — avoids flickering on fast responses
  const streamTimer = setTimeout(() => {
    stream.started = true;
  }, 1000);

  try {
    const { onStreamDelta, onTextBlock } = createStreamCallbacks(
      bot,
      numericChatId,
      replyToId,
      stream,
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
      onToolUse: (toolName, input) => {
        if (
          toolName === "send" &&
          input.type === "text" &&
          typeof input.text === "string"
        ) {
          appendDailyLogResponse("Talon", input.text, { chatTitle });
        }
      },
    });

    if (
      result.bridgeMessageCount === 0 &&
      !stream.sentTextBlock &&
      result.text?.trim()
    ) {
      log(
        "bot",
        `Suppressed fallback text (${result.text.length} chars) — no send tool used`,
      );
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

// ── Message handlers ─────────────────────────────────────────────────────────

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
