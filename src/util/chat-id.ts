/**
 * Shared chat-ID utilities used by terminal and Teams frontends.
 */

import { createHash } from "node:crypto";

/** Derive a stable 32-bit numeric chat ID from a string chat ID. */
export function deriveNumericChatId(chatId: string): number {
  const hash = createHash("sha256").update(chatId).digest();
  return hash.readUInt32BE(0);
}

/** Generate a unique terminal chat ID. */
export function generateTerminalChatId(): string {
  return `t_${Date.now()}`;
}

/** Check if a chat ID belongs to a terminal session. */
export function isTerminalChatId(chatId: string): boolean {
  return chatId.startsWith("t_") || chatId === "1";
}

/**
 * Generate a unique native chat ID. A short random suffix is appended so
 * two chats created within the same millisecond don't collide (the native
 * UI lets you spin up several conversations quickly).
 */
export function generateNativeChatId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `d_${Date.now()}_${rand}`;
}

/** Check if a chat ID belongs to a native session. */
export function isNativeChatId(chatId: string): boolean {
  return chatId.startsWith("d_");
}

/** Check if a chat ID belongs to a Telegram session. */
export function isTelegramChatId(chatId: string): boolean {
  return /^-?\d+$/.test(chatId);
}

/** Check if a chat ID belongs to a Teams session. */
export function isTeamsChatId(chatId: string): boolean {
  return chatId.startsWith("teams_chat_");
}

/** Check if a chat ID belongs to a Discord session. */
export function isDiscordChatId(chatId: string): boolean {
  return chatId.startsWith("discord_");
}
