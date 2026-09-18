/**
 * Per-chat wire projection — a registry entry plus its persisted settings,
 * cached context fill and queued follow-up, as the `ClientChat` clients
 * render. `chat_updated` is always built from here so every client sees the
 * same shape.
 */

import {
  getChatSettings,
  getChatModelForBackend,
} from "../../../storage/chat-settings.js";
import { getBackendIdForChat } from "../../../core/engine/backend-controller/index.js";
import type { ChatEntry } from "./chats.js";
import type { ClientChat, QueuedMessage } from "../protocol.js";
import type { NativeRuntime } from "../runtime.js";

/** Project the stored queue entry to its wire shape (text + attachments). */
function toQueued(
  runtime: NativeRuntime,
  chatId: string,
): QueuedMessage | undefined {
  const q = runtime.queuedByChat.get(chatId);
  if (!q) return undefined;
  return {
    text: q.text,
    hasAttachment: q.attachments.length > 0,
    attachmentCount: q.attachments.length,
  };
}

export function toClientChat(
  runtime: NativeRuntime,
  entry: ChatEntry,
): ClientChat {
  const settings = getChatSettings(entry.id);
  let model: string | undefined;
  let backend: string | undefined;
  try {
    // The persisted per-chat setting is the source of truth for what the
    // user picked; the in-memory binding can lag it (boot-time rebind
    // still pending or transiently failed). Reporting the binding here
    // made clients show a chat "reset" to the default backend after a
    // daemon restart even though the user's choice was intact.
    backend = settings.backend ?? getBackendIdForChat(entry.id);
    model = getChatModelForBackend(entry.id, backend);
  } catch {
    backend = settings.backend;
    /* backend pool not ready (early boot) — omit model */
  }
  return {
    id: entry.id,
    title: entry.title,
    createdAt: entry.createdAt,
    lastActive: entry.lastActive,
    preview: entry.preview,
    model,
    backend,
    effort: settings.effort,
    pulse: settings.pulse,
    context: runtime.contextByChat.get(entry.id),
    queued: toQueued(runtime, entry.id),
  };
}

export function broadcastChatUpdated(
  runtime: NativeRuntime,
  entry: ChatEntry,
): void {
  runtime.broadcast({
    kind: "chat_updated",
    chat: toClientChat(runtime, entry),
  });
}
