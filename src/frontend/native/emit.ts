/**
 * Outbound message helpers — persist a message to history (where it should
 * persist), touch the chat, and broadcast it to every client.
 */

import { pushMessage } from "../../storage/history.js";
import { extractSessionName } from "../../util/session-name.js";
import { broadcastChatUpdated } from "./chat-wire.js";
import { DEFAULT_CHAT_TITLE, type ChatEntry } from "./chats.js";
import { mediaUrl, registerMedia } from "./media.js";
import {
  BOT_SENDER_ID,
  USER_SENDER_ID,
  type ClientButton,
  type ClientMessage,
} from "./protocol.js";
import type { NativeRuntime } from "./runtime.js";

/**
 * Name a chat from its first user message — instantly and for free.
 *
 * The title is a trimmed slice of the first message (no model call), so it
 * lands the moment the user hits send instead of staying "New chat" until
 * the turn finishes and a restart re-hydrates the persisted name. Only fires
 * while the chat still carries the placeholder title, so a user's manual
 * rename is never clobbered. Callers broadcast `chat_updated` afterwards, so
 * the change propagates to every connected client live.
 */
function maybeAutoTitle(
  runtime: NativeRuntime,
  entry: ChatEntry,
  text: string,
): void {
  if (entry.title && entry.title !== DEFAULT_CHAT_TITLE) return;
  const title = extractSessionName(text);
  if (title) runtime.chats.rename(entry.id, title);
}

export function emitAssistant(
  runtime: NativeRuntime,
  entry: ChatEntry,
  text: string,
  buttons?: ClientButton[][],
): number {
  const id = runtime.nextId();
  const ts = Date.now();
  const message: ClientMessage = {
    id: String(id),
    chatId: entry.id,
    role: "assistant",
    text,
    ts,
    ...(buttons ? { buttons } : {}),
  };
  pushMessage(entry.id, {
    msgId: id,
    senderId: BOT_SENDER_ID,
    senderName: runtime.botName,
    text,
    timestamp: ts,
  });
  runtime.chats.touch(entry.id, text);
  runtime.lastAssistantId.set(entry.id, String(id));
  runtime.broadcast({ kind: "message", chatId: entry.id, message });
  broadcastChatUpdated(runtime, entry);
  return id;
}

/** Persist + broadcast an assistant photo message (image + optional caption). */
export function emitPhoto(
  runtime: NativeRuntime,
  entry: ChatEntry,
  filePath: string,
  caption?: string,
): number {
  const id = runtime.nextId();
  const ts = Date.now();
  const text = caption?.trim() ?? "";
  const mediaId = registerMedia(runtime, filePath);
  const message: ClientMessage = {
    id: String(id),
    chatId: entry.id,
    role: "assistant",
    text,
    ts,
    imagePath: mediaUrl(mediaId),
  };
  // Persist the image reference so it re-renders when history reloads (the
  // filePath is re-registered into the media map on read). The caption is
  // stored as plain text; the `photo` mediaType carries the image marker.
  pushMessage(entry.id, {
    msgId: id,
    senderId: BOT_SENDER_ID,
    senderName: runtime.botName,
    text,
    timestamp: ts,
    mediaType: "photo",
    filePath,
  });
  runtime.chats.touch(entry.id, text || "[photo]");
  runtime.lastAssistantId.set(entry.id, String(id));
  runtime.broadcast({ kind: "message", chatId: entry.id, message });
  broadcastChatUpdated(runtime, entry);
  return id;
}

/** Persist + broadcast a user message; returns its numeric id so the turn
 *  hands the model that same id (as `[msg_id:N]`) to react/reply to.
 *  An optional imagePath renders an attached image inline. */
export function emitUser(
  runtime: NativeRuntime,
  entry: ChatEntry,
  text: string,
  imagePath?: string,
  attachmentPath?: string,
): number {
  const id = runtime.nextId();
  const ts = Date.now();
  const message: ClientMessage = {
    id: String(id),
    chatId: entry.id,
    role: "user",
    text,
    ts,
    ...(imagePath ? { imagePath } : {}),
  };
  // For an attached image, persist the on-disk path + a `photo` mediaType so
  // it re-renders on history reload (rehydrated in the `history` handler)
  // instead of vanishing to a text-only placeholder. Caption stays as text.
  pushMessage(entry.id, {
    msgId: id,
    senderId: USER_SENDER_ID,
    senderName: "User",
    text,
    timestamp: ts,
    ...(imagePath
      ? {
          mediaType: "photo" as const,
          ...(attachmentPath ? { filePath: attachmentPath } : {}),
        }
      : {}),
  });
  runtime.chats.touch(entry.id, imagePath ? text || "[photo]" : text);
  maybeAutoTitle(runtime, entry, text);
  runtime.broadcast({ kind: "message", chatId: entry.id, message });
  broadcastChatUpdated(runtime, entry);
  return id;
}

/** Transient, non-persisted notice (e.g. "session reset"). */
export function emitSystem(
  runtime: NativeRuntime,
  entry: ChatEntry,
  text: string,
): void {
  runtime.broadcast({
    kind: "message",
    chatId: entry.id,
    message: {
      id: `sys-${runtime.nextId()}`,
      chatId: entry.id,
      role: "system",
      text,
      ts: Date.now(),
    },
  });
}
