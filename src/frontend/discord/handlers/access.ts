/**
 * Access control — DM whitelist, guild/channel allowlists, admin checks,
 * mention/respond gating, unauthorized notifications, DM-user tracking, and
 * per-user rate limiting.
 */

import type { Client, Message } from "discord.js";
import { ChannelType } from "discord.js";
import { appendDailyLog } from "../../../storage/daily-log.js";
import { log, logWarn, logDebug } from "../../../util/log.js";
import { escapeMarkdown } from "../formatting.js";
import {
  accessState,
  knownDmUsers,
  KNOWN_DM_USERS_CAP,
  unauthorizedCooldown,
  UNAUTHORIZED_COOLDOWN_MS,
  MAX_UNAUTHORIZED_COOLDOWNS,
  userMessageTimestamps,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_MESSAGES,
  type AccessConfig,
} from "./state.js";

export function setAccessControl(cfg: {
  allowedUsers: string[];
  allowedGuilds: string[];
  allowedChannels: string[];
  adminUserIds: string[];
  respondMode: "mention" | "channel";
}): void {
  accessState.access = {
    allowedUsers: new Set(cfg.allowedUsers),
    allowedGuilds: new Set(cfg.allowedGuilds),
    allowedChannels: new Set(cfg.allowedChannels),
    adminUserIds: new Set(cfg.adminUserIds),
    respondMode: cfg.respondMode,
  };
}

export function isAdmin(userId: string): boolean {
  return accessState.access.adminUserIds.has(userId);
}

export function getAccessSnapshot(): AccessConfig {
  return accessState.access;
}

export function trackDmUser(
  senderId: string,
  senderName: string,
  tag?: string,
): void {
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
  for (const adminId of accessState.access.adminUserIds) {
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
  return accessState.access.allowedUsers.has(userId);
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

  if (!accessState.access.allowedGuilds.has(guildId)) {
    await notifyUnauthorized(client, msg, "guild");
    return false;
  }
  if (
    accessState.access.allowedChannels.size > 0 &&
    !accessState.access.allowedChannels.has(msg.channelId)
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
  if (!accessState.access.allowedGuilds.has(guildId))
    return { ok: false, reason: "This server is not authorized." };
  if (
    accessState.access.allowedChannels.size > 0 &&
    channelId &&
    !accessState.access.allowedChannels.has(channelId)
  )
    return { ok: false, reason: "This channel is not authorized." };
  return { ok: true };
}

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

  if (
    accessState.access.respondMode === "channel" &&
    accessState.access.allowedChannels.size > 0
  ) {
    return accessState.access.allowedChannels.has(msg.channelId);
  }
  return Boolean(mentioned || repliedToBot);
}

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
