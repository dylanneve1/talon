/**
 * Shared chat-ID utilities used by terminal and Teams frontends.
 */

import { createHash } from "node:crypto";

/** Derive a stable 32-bit numeric chat ID from a string chat ID. */
export function deriveNumericChatId(chatId: string): number {
  const hash = createHash("sha256").update(chatId).digest();
  return hash.readUInt32BE(0);
}

/**
 * The numeric id a frontend uses for a chat. Telegram ids are numeric
 * already; every other frontend (native, WhatsApp, Discord, Teams, terminal)
 * derives its numeric id from the string one with `deriveNumericChatId`.
 * This is the inverse the background runtimes need to address a stored
 * string chat id the way its frontend does.
 */
export function numericChatIdFor(chatId: string): number {
  return isTelegramChatId(chatId)
    ? Number(chatId)
    : deriveNumericChatId(chatId);
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

/** Check if a chat ID belongs to a WhatsApp session. */
export function isWhatsAppChatId(chatId: string): boolean {
  return chatId.startsWith("wa_");
}

/** Check if a chat ID belongs to a Discord session. */
export function isDiscordChatId(chatId: string): boolean {
  return chatId.startsWith("discord_");
}

/**
 * Classify a canonical chat ID as a one-to-one chat, a multi-party one,
 * or something this grammar cannot tell apart.
 *
 * The ID is the only signal engine-side code has: a frontend's own
 * `isGroup` flag rides on the inbound message, while stores, jobs and
 * gateway actions are keyed by the string ID alone. Per frontend:
 *
 *   - `discord_guild_…` / `discord_dm_…` and `wa_group_…` / `wa_dm_…`
 *     say which they are outright;
 *   - a Telegram ID is bare digits — negative for a group, supergroup or
 *     channel, positive for the user's own ID (a DM);
 *   - terminal (`t_…`, `"1"`) and native (`d_…`) chats are local,
 *     single-operator surfaces, so they are DMs;
 *   - `teams_chat_…` covers 1:1 *and* group Teams chats alike, so it is
 *     `"unknown"` — as is anything a future frontend invents.
 *
 * Callers decide what `"unknown"` means for them; anything trust- or
 * privacy-sensitive should treat it as a group and fail closed.
 */
export function chatScope(chatId: string): "dm" | "group" | "unknown" {
  if (chatId.startsWith("discord_guild_")) return "group";
  if (chatId.startsWith("discord_dm_")) return "dm";
  if (chatId.startsWith("wa_group_")) return "group";
  if (chatId.startsWith("wa_dm_")) return "dm";
  if (isTelegramChatId(chatId)) return chatId.startsWith("-") ? "group" : "dm";
  if (isTerminalChatId(chatId) || isNativeChatId(chatId)) return "dm";
  return "unknown";
}
