/**
 * Chat lifecycle — create, rename and delete, each broadcast so every open
 * client list updates in place.
 */

import { toClientChat } from "./chat-wire.js";
import type { ClientChat } from "./protocol.js";
import type { NativeRuntime } from "./runtime.js";
import { clearTurnMeta } from "./turn-meta.js";

export function createChat(runtime: NativeRuntime, title?: string): ClientChat {
  const entry = runtime.chats.create(title);
  const chat = toClientChat(runtime, entry);
  runtime.broadcast({ kind: "chat_created", chat });
  return chat;
}

export function renameChat(
  runtime: NativeRuntime,
  chatId: string,
  title: string,
): ClientChat | null {
  const entry = runtime.chats.rename(chatId, title);
  if (!entry) return null;
  const chat = toClientChat(runtime, entry);
  runtime.broadcast({ kind: "chat_updated", chat });
  return chat;
}

export function deleteChat(runtime: NativeRuntime, chatId: string): boolean {
  const ok = runtime.chats.remove(chatId);
  if (ok) {
    clearTurnMeta(chatId);
    runtime.contextByChat.delete(chatId);
    runtime.queuedByChat.delete(chatId);
    runtime.broadcast({ kind: "chat_deleted", chatId });
  }
  return ok;
}
