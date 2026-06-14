/**
 * Discord message handlers — access control, debounce queue, attachment download,
 * processAndReply with streaming.
 *
 * Mirrors src/frontend/telegram/handlers.ts. Differences:
 *  - chat IDs are Discord snowflakes (strings); numericChatId is a sha256-derived
 *    32-bit hash (see util/chat-id.ts) so the gateway/dispatcher (number-keyed)
 *    can route correctly.
 *  - access control gates by allowedUsers (DM) and allowedGuilds + optional
 *    allowedChannels (guild). adminUserIds is a list, not a single ID.
 *  - "shouldHandleInGuild" honors respondMode ("mention" → only @bot/reply,
 *    "channel" → all messages in allowedChannels).
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Client, Message, Attachment, TextBasedChannel } from "discord.js";
import { ChannelType } from "discord.js";
import type { TalonConfig } from "../../util/config.js";
import { execute } from "../../core/engine/dispatcher.js";
import { toolInputToRecord } from "../../core/agent-runtime/events.js";
import { classify, friendlyMessage } from "../../core/errors.js";
import {
  appendDailyLog,
  appendDailyLogResponse,
} from "../../storage/daily-log.js";
import { setMessageFilePath } from "../../storage/history.js";
import { addMedia } from "../../storage/media-index.js";
import { recordMessageProcessed, recordError } from "../../util/watchdog.js";
import { deriveNumericChatId } from "../../util/chat-id.js";
import { log, logError, logWarn, logDebug } from "../../util/log.js";
import {
  splitMessage,
  suppressMentions,
  escapeMarkdown,
  DISCORD_MAX_TEXT,
} from "./formatting.js";

// ── Chat registry: numericChatId → Discord channel info ─────────────────────
// The gateway/dispatcher uses numeric chatIds. Action handlers need to map
// back to the Discord channel they should post to. We maintain a registry,
// updated whenever a message arrives or an interaction is processed.

export type DiscordChatInfo = {
  channelId: string;
  guildId: string | null;
  userId: string | null; // for DM contexts
  numericChatId: number;
  chatId: string;
};

const chatRegistry = new Map<number, DiscordChatInfo>();
const chatRegistryByString = new Map<string, DiscordChatInfo>();

export function registerDiscordChat(info: DiscordChatInfo): void {
  chatRegistry.set(info.numericChatId, info);
  chatRegistryByString.set(info.chatId, info);
}

export function lookupDiscordChat(
  numericChatId: number,
): DiscordChatInfo | undefined {
  return chatRegistry.get(numericChatId);
}

export function lookupDiscordChatByString(
  chatId: string,
): DiscordChatInfo | undefined {
  return chatRegistryByString.get(chatId);
}

// ── Access control state ─────────────────────────────────────────────────────

type AccessConfig = {
  allowedUsers: Set<string>;
  allowedGuilds: Set<string>;
  allowedChannels: Set<string>; // empty = all channels in allowedGuilds
  adminUserIds: Set<string>;
  respondMode: "mention" | "channel";
};

let access: AccessConfig = {
  allowedUsers: new Set(),
  allowedGuilds: new Set(),
  allowedChannels: new Set(),
  adminUserIds: new Set(),
  respondMode: "mention",
};

export function setAccessControl(cfg: {
  allowedUsers: string[];
  allowedGuilds: string[];
  allowedChannels: string[];
  adminUserIds: string[];
  respondMode: "mention" | "channel";
}): void {
  access = {
    allowedUsers: new Set(cfg.allowedUsers),
    allowedGuilds: new Set(cfg.allowedGuilds),
    allowedChannels: new Set(cfg.allowedChannels),
    adminUserIds: new Set(cfg.adminUserIds),
    respondMode: cfg.respondMode,
  };
}

export function isAdmin(userId: string): boolean {
  return access.adminUserIds.has(userId);
}

export function getAccessSnapshot(): AccessConfig {
  return access;
}

// ── First-time DM user tracking ──────────────────────────────────────────────

const knownDmUsers = new Set<string>();
const KNOWN_DM_USERS_CAP = 10_000;

function trackDmUser(senderId: string, senderName: string, tag?: string): void {
  if (knownDmUsers.has(senderId)) return;
  if (knownDmUsers.size >= KNOWN_DM_USERS_CAP) {
    const evictCount = Math.floor(KNOWN_DM_USERS_CAP * 0.1);
    const iter = knownDmUsers.values();
    for (let i = 0; i < evictCount; i++) {
      knownDmUsers.delete(iter.next().value as string);
    }
  }
  knownDmUsers.add(senderId);
  const tagStr = tag ? ` (${tag})` : "";
  log("users", `New DM user: ${senderName}${tagStr} [id:${senderId}]`);
  appendDailyLog(
    "System",
    `New DM user: ${senderName}${tagStr} [id:${senderId}]`,
  );
}

// ── Unauthorized notification (cooldown 10 min, like Telegram) ───────────────

const unauthorizedCooldown = new Map<string, number>();
const UNAUTHORIZED_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_UNAUTHORIZED_COOLDOWNS = 5000;

async function notifyUnauthorized(
  client: Client,
  msg: Message,
  type: "dm" | "guild" | "channel",
): Promise<void> {
  const userId = msg.author.id;
  const guildId = msg.guildId ?? "";
  const channelId = msg.channelId;
  const key =
    type === "dm"
      ? `dm:${userId}`
      : type === "guild"
        ? `guild:${guildId}`
        : `channel:${channelId}`;
  const now = Date.now();
  const last = unauthorizedCooldown.get(key);
  if (last && now - last < UNAUTHORIZED_COOLDOWN_MS) return;
  if (unauthorizedCooldown.size >= MAX_UNAUTHORIZED_COOLDOWNS) {
    unauthorizedCooldown.clear();
  }
  unauthorizedCooldown.set(key, now);

  const senderTag = msg.author.username ? ` (@${msg.author.username})` : "";
  const senderName = msg.author.globalName || msg.author.username || "User";

  // Warn the user
  try {
    if (msg.channel.isSendable()) {
      await msg.channel.send({
        content:
          "⚠️ Unauthorized access. This bot is private. This attempt has been reported to the bot owner.",
        allowedMentions: { parse: [] },
      });
    }
  } catch {
    /* can't send — ignore */
  }

  // Notify admins via DM. User-supplied names (sender, guild, channel) are
  // escaped so a nick containing ** or || can't deform the admin's message.
  const safeSender = escapeMarkdown(`${senderName}${senderTag}`);
  const safeGuildName = escapeMarkdown(msg.guild?.name ?? guildId);
  const safeChannelName = escapeMarkdown(
    (msg.channel as { name?: string }).name ?? channelId,
  );
  for (const adminId of access.adminUserIds) {
    try {
      const admin = await client.users.fetch(adminId);
      const detail =
        type === "dm"
          ? `🚨 Unauthorized DM from ${safeSender} [id:${userId}]`
          : type === "guild"
            ? `🚨 Unauthorized guild access: "${safeGuildName}" [id:${guildId}] by ${safeSender}`
            : `🚨 Unauthorized channel access: #${safeChannelName} in "${safeGuildName}" by ${safeSender}`;
      await admin.send({ content: detail, allowedMentions: { parse: [] } });
    } catch {
      /* admin unreachable */
    }
  }

  logWarn(
    "access",
    `Unauthorized ${type}: ${senderName}${senderTag} [id:${userId}] guild=${guildId} channel=${channelId}`,
  );
}

/** Check if a DM user is allowed. */
function isDmAllowed(userId: string): boolean {
  return access.allowedUsers.has(userId);
}

/**
 * Full access check for plain messages. Returns true if message should be processed.
 * Notifies user + admins on rejection (with cooldown).
 */
export async function isAccessAllowed(
  client: Client,
  msg: Message,
): Promise<boolean> {
  if (msg.channel.type === ChannelType.DM) {
    if (isDmAllowed(msg.author.id)) return true;
    await notifyUnauthorized(client, msg, "dm");
    return false;
  }
  // Guild context
  const guildId = msg.guildId;
  if (!guildId) return false; // unknown — deny

  if (!access.allowedGuilds.has(guildId)) {
    await notifyUnauthorized(client, msg, "guild");
    return false;
  }
  if (
    access.allowedChannels.size > 0 &&
    !access.allowedChannels.has(msg.channelId)
  ) {
    await notifyUnauthorized(client, msg, "channel");
    return false;
  }
  return true;
}

/**
 * For interactions (slash commands, buttons): synchronous predicate without
 * side effects, since the interaction has its own ephemeral reply path.
 */
export function isInteractionAllowed(
  inGuild: boolean,
  userId: string,
  guildId: string | null,
  channelId: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (!inGuild) {
    if (isDmAllowed(userId)) return { ok: true };
    return { ok: false, reason: "DM access not authorized." };
  }
  if (!guildId)
    return { ok: false, reason: "Could not determine guild context." };
  if (!access.allowedGuilds.has(guildId))
    return { ok: false, reason: "This server is not authorized." };
  if (
    access.allowedChannels.size > 0 &&
    channelId &&
    !access.allowedChannels.has(channelId)
  )
    return { ok: false, reason: "This channel is not authorized." };
  return { ok: true };
}

// ── Mention/respond gating in guilds ─────────────────────────────────────────

/**
 * Whether a guild message should activate the bot.
 *  - mode "mention": only if @bot or reply-to-bot
 *  - mode "channel": any message inside an allowedChannels channel (whitelist
 *    must be set; otherwise we fall back to mention to avoid being noisy).
 */
export function shouldHandleInGuild(client: Client, msg: Message): boolean {
  if (msg.channel.type === ChannelType.DM) return true;

  const botId = client.user?.id;
  const mentioned = botId ? msg.mentions.users.has(botId) : false;
  const repliedToBot =
    msg.reference?.messageId && msg.mentions.repliedUser?.id === botId;

  if (access.respondMode === "channel" && access.allowedChannels.size > 0) {
    return access.allowedChannels.has(msg.channelId);
  }
  return Boolean(mentioned || repliedToBot);
}

// ── Per-user rate limiting ───────────────────────────────────────────────────

const userMessageTimestamps = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_MESSAGES = 15;

export function isUserRateLimited(senderId: string): boolean {
  const now = Date.now();
  let timestamps = userMessageTimestamps.get(senderId);
  if (!timestamps) {
    timestamps = [];
    userMessageTimestamps.set(senderId, timestamps);
  }
  while (timestamps.length > 0 && timestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
    logDebug("bot", `Rate-limited user ${senderId}`);
    return true;
  }
  timestamps.push(now);
  if (userMessageTimestamps.size > 5_000) {
    const cutoff = now - 10 * 60_000;
    for (const [userId, ts] of userMessageTimestamps) {
      if (ts.length === 0 || ts[ts.length - 1] < cutoff) {
        userMessageTimestamps.delete(userId);
      }
      if (userMessageTimestamps.size <= 2_500) break;
    }
  }
  return false;
}

// ── Sender/reply/forward context helpers ─────────────────────────────────────

export function getSenderName(msg: Message): string {
  return (
    (msg.member?.displayName || msg.author.globalName || msg.author.username) ??
    "User"
  );
}

function buildReplyContext(msg: Message, botId: string | undefined): string {
  const ref = msg.reference;
  if (!ref || !ref.messageId) return "";
  // We don't always have the message cached. Discord.js provides
  // msg.fetchReference() but that's async; we keep this synchronous and rely
  // on the partial info already available via mentions.repliedUser.
  const replied = msg.mentions.repliedUser;
  if (!replied) return `[Replying to msg_id:${ref.messageId}]\n\n`;
  const author =
    replied.id === botId
      ? "bot"
      : replied.globalName || replied.username || "User";
  return `[Replying to ${author} msg_id:${ref.messageId}]\n\n`;
}

// ── Attachment download ──────────────────────────────────────────────────────

const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

async function downloadAttachment(
  attachment: Attachment,
  workspace: string,
): Promise<string> {
  if (attachment.size && attachment.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `File too large (${Math.round(attachment.size / 1024 / 1024)}MB, max ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB).`,
    );
  }
  const resp = await fetch(attachment.url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length === 0) throw new Error("Downloaded file is empty.");

  const safeName = (attachment.name || `att_${attachment.id}`).replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  const uploadsDir = resolve(workspace, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const dest = resolve(uploadsDir, `${Date.now()}-${safeName}`);
  writeFileSync(dest, buffer);
  return dest;
}

function classifyAttachment(att: Attachment): {
  type: "photo" | "document" | "voice" | "video" | "audio" | "animation";
  promptLines: (savedPath: string) => string[];
} {
  const ct = att.contentType ?? "";
  const name = (att.name ?? "").toLowerCase();

  if (ct.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/.test(name)) {
    if (ct === "image/gif" || name.endsWith(".gif")) {
      return {
        type: "animation",
        promptLines: (p) => [
          `User sent a GIF: "${att.name ?? att.id}".`,
          `Saved to: ${p}`,
        ],
      };
    }
    return {
      type: "photo",
      promptLines: (p) => [
        `User sent an image saved to: ${p}`,
        "Read this file to view it. If you need to reference this image in future turns, re-read the file — image data does not persist between turns.",
      ],
    };
  }
  if (ct.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/.test(name)) {
    return {
      type: "video",
      promptLines: (p) => [
        `User sent a video: "${att.name ?? att.id}".`,
        `Saved to: ${p}`,
      ],
    };
  }
  if (
    ct === "audio/ogg" ||
    /voice/.test(name) ||
    (att.waveform != null && ct.startsWith("audio/"))
  ) {
    return {
      type: "voice",
      promptLines: (p) => [
        `User sent a voice message (${att.duration ?? "?"}s).`,
        `Audio saved to: ${p}. You cannot transcribe audio — acknowledge it and respond based on context.`,
      ],
    };
  }
  if (ct.startsWith("audio/") || /\.(mp3|wav|flac|m4a|opus)$/.test(name)) {
    return {
      type: "audio",
      promptLines: (p) => [
        `User sent an audio file: "${att.name ?? att.id}".`,
        `Saved to: ${p}`,
      ],
    };
  }
  return {
    type: "document",
    promptLines: (p) => [
      `User sent a document: "${att.name ?? att.id}" (${ct || "unknown"}).`,
      `Saved to: ${p}`,
      "Read and process this file.",
    ],
  };
}

// ── Send helpers ─────────────────────────────────────────────────────────────

async function sendChunked(
  channel: TextBasedChannel,
  text: string,
  replyToId?: string,
): Promise<string[]> {
  const ids: string[] = [];
  if (!text.trim()) return ids;
  const chunks = splitMessage(suppressMentions(text), DISCORD_MAX_TEXT);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!channel.isSendable()) continue;
    // Let errors propagate so withRetry can classify + retry transient failures.
    // Previously we swallowed all errors here, making the outer withRetry dead code.
    const sent = await channel.send({
      content: chunk,
      allowedMentions: { parse: [] },
      reply:
        i === 0 && replyToId
          ? { messageReference: replyToId, failIfNotExists: false }
          : undefined,
    });
    ids.push(sent.id);
  }
  return ids;
}

// ── Message queue (debounce rapid-fire messages per chat) ────────────────────

type QueuedMessage = {
  prompt: string;
  replyToId: string;
  messageId: string;
  numericMessageId: number;
  senderName: string;
  senderUsername?: string;
  senderId: string;
  isGroup: boolean;
  channel: TextBasedChannel;
  chatTitle?: string;
};

const messageQueues = new Map<
  string,
  {
    messages: QueuedMessage[];
    timer: ReturnType<typeof setTimeout>;
    config: TalonConfig;
    chatId: string;
    numericChatId: number;
  }
>();

const DEBOUNCE_MS = 500;
const MAX_QUEUED_PER_CHAT = 20;

function enqueueMessage(
  config: TalonConfig,
  chatId: string,
  numericChatId: number,
  msg: QueuedMessage,
): void {
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

  try {
    await processAndReply({
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
        await processAndReply({
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

// ── processAndReply ─────────────────────────────────────────────────────────

type ProcessAndReplyParams = {
  config: TalonConfig;
  chatId: string;
  numericChatId: number;
  replyToId: string;
  messageId: string;
  numericMessageId: number;
  prompt: string;
  senderName: string;
  isGroup: boolean;
  senderUsername?: string;
  senderId: string;
  channel: TextBasedChannel;
  chatTitle?: string;
};

async function processAndReply(p: ProcessAndReplyParams): Promise<void> {
  const sentTextBlock = { value: false };
  let firstChunkReplyTo: string | undefined = p.replyToId;

  // Discord doesn't support draft message edits, so we use onTextBlock to
  // deliver each text block as a discrete message (chunked if necessary).
  const onTextBlock = async (text: string) => {
    if (!text.trim()) return;
    const ids = await sendChunked(p.channel, text, firstChunkReplyTo);
    if (ids.length > 0) sentTextBlock.value = true;
    // Subsequent blocks should not reply to the original — too noisy.
    firstChunkReplyTo = undefined;
  };

  if (!p.isGroup && p.senderId) {
    trackDmUser(p.senderId, p.senderName, p.senderUsername);
  }

  const result = await execute({
    chatId: p.chatId,
    numericChatId: p.numericChatId,
    prompt: p.prompt,
    senderName: p.senderName,
    isGroup: p.isGroup,
    // Use the real Discord snowflake string, not the hashed numeric.
    // The hash collides with Telegram-style 32-bit IDs and Discord's API
    // rejects it as "Unknown Message" when the model tries to react/edit.
    messageId: p.messageId,
    source: "message",
    onEvent: async (event) => {
      switch (event.type) {
        case "assistant_message":
          // Throw on delivery failure — the dispatcher rejects the ack.
          await onTextBlock(event.text);
          break;
        case "tool_call": {
          const input = toolInputToRecord(event.name, event.input);
          if (
            event.name === "send" &&
            input.type === "text" &&
            typeof input.text === "string"
          ) {
            appendDailyLogResponse("Talon", input.text, {
              chatTitle: p.chatTitle,
            });
          }
          break;
        }
      }
    },
  });

  if (
    result.bridgeMessageCount === 0 &&
    !sentTextBlock.value &&
    result.text?.trim()
  ) {
    log(
      "bot",
      `Suppressed fallback text (${result.text.length} chars) — no send tool used`,
    );
  }
}

// ── Public message handler ──────────────────────────────────────────────────

export async function handleMessage(
  client: Client,
  msg: Message,
  config: TalonConfig,
): Promise<void> {
  // Ignore bots, system messages, and our own messages
  if (msg.author.bot || msg.system) return;
  if (msg.author.id === client.user?.id) return;

  if (!shouldHandleInGuild(client, msg)) return;
  if (!(await isAccessAllowed(client, msg))) return;
  if (isUserRateLimited(msg.author.id)) return;

  const isGroup = msg.channel.type !== ChannelType.DM;
  const chatId = isGroup
    ? `discord_guild_${msg.guildId}_${msg.channelId}`
    : `discord_dm_${msg.author.id}`;
  const numericChatId = deriveNumericChatId(chatId);
  const numericMessageId = deriveNumericChatId(msg.id);
  const sender = getSenderName(msg);
  const senderUsername = msg.author.username;
  const channel = msg.channel;
  const chatTitle = isGroup
    ? `${msg.guild?.name ?? msg.guildId} #${(msg.channel as { name?: string }).name ?? msg.channelId}`
    : undefined;

  // Strip the leading bot mention from the text — common when users invoke the bot.
  const botId = client.user?.id;
  const mentionPattern = botId ? new RegExp(`<@!?${botId}>`, "g") : null;
  const cleanedContent = mentionPattern
    ? msg.content.replace(mentionPattern, "").trim()
    : msg.content.trim();

  // Build prompt parts
  const replyCtx = buildReplyContext(msg, botId);
  const promptParts: string[] = [replyCtx];

  // Handle attachments — download each, register in media index/history, add to prompt.
  if (msg.attachments.size > 0) {
    for (const att of msg.attachments.values()) {
      try {
        const savedPath = await downloadAttachment(att, config.workspace);
        const cls = classifyAttachment(att);
        setMessageFilePath(chatId, numericMessageId, savedPath);
        addMedia({
          chatId,
          msgId: numericMessageId,
          senderName: sender,
          type: cls.type,
          filePath: savedPath,
          caption: cleanedContent || undefined,
          timestamp: Date.now(),
        });
        promptParts.push(...cls.promptLines(savedPath));
      } catch (err) {
        logError(
          "bot",
          `[${chatId}] attachment "${att.name}" download failed: ${err instanceof Error ? err.message : err}`,
        );
        promptParts.push(
          `[Attachment "${att.name ?? "file"}" failed to download: ${err instanceof Error ? err.message : err}]`,
        );
      }
    }
    if (cleanedContent) promptParts.push(`Caption: ${cleanedContent}`);
  } else if (cleanedContent) {
    promptParts.push(cleanedContent);
  }

  const prompt = promptParts.filter(Boolean).join("\n");
  if (!prompt.trim()) return;

  registerDiscordChat({
    channelId: msg.channelId,
    guildId: msg.guildId,
    userId: isGroup ? null : msg.author.id,
    numericChatId,
    chatId,
  });

  enqueueMessage(config, chatId, numericChatId, {
    prompt,
    replyToId: msg.id,
    messageId: msg.id,
    numericMessageId,
    senderName: sender,
    senderUsername,
    senderId: msg.author.id,
    isGroup,
    channel,
    chatTitle,
  });
}

/** Exposed so the action handler can use the same chunked send for tool calls. */
export { sendChunked };
