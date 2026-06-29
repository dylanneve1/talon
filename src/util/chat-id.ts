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
 * Generate a unique desktop chat ID. A short random suffix is appended so
 * two chats created within the same millisecond don't collide (the desktop
 * UI lets you spin up several conversations quickly).
 */
export function generateDesktopChatId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `d_${Date.now()}_${rand}`;
}

/** Check if a chat ID belongs to a desktop session. */
export function isDesktopChatId(chatId: string): boolean {
  return chatId.startsWith("d_");
}
