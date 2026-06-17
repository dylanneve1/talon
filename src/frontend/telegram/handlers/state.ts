/**
 * Shared module-level state for the Telegram message-handling pipeline.
 *
 * Each Map/Set is created once here and imported by the handler submodules
 * so refcounts, caches, and queues stay coherent across files. Values that
 * are reassigned (the access-control config) live on a holder object so other
 * modules can mutate them through the import.
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../../util/config.js";

// ── First-time DM user tracking ──────────────────────────────────────────────

export const knownDmUsers = new Set<number>();
export const KNOWN_DM_USERS_CAP = 10_000;

// ── Access control ──────────────────────────────────────────────────────────

/** Reassignable access config — holder object so setAccessControl can mutate. */
export const accessConfig: {
  allowedUserIds: Set<number> | null; // null = no whitelist (allow all)
  adminId: number;
} = {
  allowedUserIds: null,
  adminId: 0,
};

// chatId → { isMember, expiresAt } — timestamp-based expiry, no timers
export const verifiedGroups = new Map<
  number,
  { isMember: boolean; expiresAt: number }
>();
export const MAX_VERIFIED_GROUPS = 1000;
export const VERIFIED_GROUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Rate-limit unauthorized access warnings (one per user/group per 10 minutes)
export const unauthorizedCooldown = new Map<string, number>();
export const UNAUTHORIZED_COOLDOWN_MS = 10 * 60 * 1000;
export const MAX_UNAUTHORIZED_COOLDOWNS = 5000;

// ── Message queue (debounce rapid-fire messages per chat) ─────────────────────

export type QueuedMessage = {
  prompt: string;
  replyToId: number;
  messageId: number;
  senderName: string;
  senderUsername?: string;
  senderId?: number;
  isGroup: boolean;
  chatTitle?: string;
};

export const messageQueues = new Map<
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

export const DEBOUNCE_MS = 500;
export const MAX_QUEUED_PER_CHAT = 20;
export const lastHandledMessageIdByChat = new Map<string, number>();

// ── Per-user rate limiting ──────────────────────────────────────────────────

export const userMessageTimestamps = new Map<number, number[]>();
export const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
export const RATE_LIMIT_MAX_MESSAGES = 15; // max 15 messages per minute per user
