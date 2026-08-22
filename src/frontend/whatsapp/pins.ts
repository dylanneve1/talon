/**
 * Pinned-message bookkeeping.
 *
 * WhatsApp lets a client pin a message but exposes no query for what is
 * pinned in a chat, so `get_pinned_messages` would have nothing to answer
 * with. This records the pins Talon itself places — the set the model put
 * there and may want to revisit or clear — and is deliberately honest
 * about its scope: pins made from someone's phone are invisible here.
 */

import type { StoredMessage } from "./message-store.js";

export type PinnedMessage = {
  msgId: number;
  text: string;
  senderName: string;
  pinnedAt: number;
};

/** Per-chat pins, newest last. Bounded — WhatsApp shows few pins anyway. */
const MAX_PINS_PER_CHAT = 25;
const pinsByChat = new Map<string, PinnedMessage[]>();

export function recordPin(chatId: string, message: StoredMessage): void {
  const pins = pinsByChat.get(chatId) ?? [];
  if (pins.some((pin) => pin.msgId === message.msgId)) return;
  pins.push({
    msgId: message.msgId,
    text: message.text,
    senderName: message.senderName,
    pinnedAt: Date.now(),
  });
  while (pins.length > MAX_PINS_PER_CHAT) pins.shift();
  pinsByChat.set(chatId, pins);
}

export function forgetPin(chatId: string, msgId: number): void {
  const pins = pinsByChat.get(chatId);
  if (!pins) return;
  const remaining = pins.filter((pin) => pin.msgId !== msgId);
  if (remaining.length) pinsByChat.set(chatId, remaining);
  else pinsByChat.delete(chatId);
}

export function listPins(chatId: string): PinnedMessage[] {
  return pinsByChat.get(chatId) ?? [];
}

/** Test seam: forget every recorded pin. */
export function resetPins(): void {
  pinsByChat.clear();
}
