/**
 * Shared module-level state for the Discord message-handling pipeline:
 * the chat registry, access config, DM-user tracking, unauthorized cooldown,
 * per-user rate-limit windows, and the debounce queue. Created once here and
 * imported by the handler submodules so all state stays coherent across files.
 */

import type { TextBasedChannel } from "discord.js";
import type { TalonConfig } from "../../../util/config.js";

// ── Chat registry: numericChatId → Discord channel info ─────────────────────
// The gateway/dispatcher uses numeric chatIds. Action handlers need to map
// back to the Discord channel they should post to.

export type DiscordChatInfo = {
  channelId: string;
  guildId: string | null;
  userId: string | null; // for DM contexts
  numericChatId: number;
  chatId: string;
};

export const chatRegistry = new Map<number, DiscordChatInfo>();
export const chatRegistryByString = new Map<string, DiscordChatInfo>();

// ── Access control state ─────────────────────────────────────────────────────

export type AccessConfig = {
  allowedUsers: Set<string>;
  allowedGuilds: Set<string>;
  allowedChannels: Set<string>; // empty = all channels in allowedGuilds
  adminUserIds: Set<string>;
  respondMode: "mention" | "channel";
};

/**
 * Reassignable access config on a holder object so `setAccessControl` can
 * swap it and every reader sees the update through the import.
 */
export const accessState: { access: AccessConfig } = {
  access: {
    allowedUsers: new Set(),
    allowedGuilds: new Set(),
    allowedChannels: new Set(),
    adminUserIds: new Set(),
    respondMode: "mention",
  },
};

// ── First-time DM user tracking ──────────────────────────────────────────────

export const knownDmUsers = new Set<string>();
export const KNOWN_DM_USERS_CAP = 10_000;

// ── Unauthorized notification cooldown (10 min) ──────────────────────────────

export const unauthorizedCooldown = new Map<string, number>();
export const UNAUTHORIZED_COOLDOWN_MS = 10 * 60 * 1000;
export const MAX_UNAUTHORIZED_COOLDOWNS = 5000;

// ── Per-user rate limiting ───────────────────────────────────────────────────

export const userMessageTimestamps = new Map<string, number[]>();
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_MESSAGES = 15;

// ── Message queue (debounce rapid-fire messages per chat) ────────────────────

export type QueuedMessage = {
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

export const messageQueues = new Map<
  string,
  {
    messages: QueuedMessage[];
    timer: ReturnType<typeof setTimeout>;
    config: TalonConfig;
    chatId: string;
    numericChatId: number;
  }
>();

export const DEBOUNCE_MS = 500;
export const MAX_QUEUED_PER_CHAT = 20;
