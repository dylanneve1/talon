/**
 * Queued follow-up bookkeeping — the one message a chat holds while a turn
 * is running. Every mutation is synced to clients as a `chat_updated`.
 */

import { broadcastChatUpdated } from "./chat-wire.js";
import type { ChatEntry } from "./chats.js";
import type { NativeRuntime, QueuedEntry } from "./runtime.js";

/**
 * Set (or replace) a chat's queued follow-up and sync it to every client via
 * chat_updated. Empty text with no attachments clears the queue.
 */
export function setQueued(
  runtime: NativeRuntime,
  chatId: string,
  next: QueuedEntry,
): void {
  const entry = runtime.chats.get(chatId);
  if (!entry) return;
  const text = next.text.trim();
  const attachments = next.attachments;
  if (!text && attachments.length === 0) {
    if (!runtime.queuedByChat.delete(chatId)) return;
  } else {
    runtime.queuedByChat.set(chatId, { text, attachments });
  }
  broadcastChatUpdated(runtime, entry);
}

/**
 * Remove and return a chat's queued follow-up (syncing the now-empty queue
 * to clients), or undefined when nothing was queued.
 */
export function takeQueued(
  runtime: NativeRuntime,
  entry: ChatEntry,
): QueuedEntry | undefined {
  const queued = runtime.queuedByChat.get(entry.id);
  if (!queued) return undefined;
  runtime.queuedByChat.delete(entry.id);
  broadcastChatUpdated(runtime, entry);
  return queued;
}
