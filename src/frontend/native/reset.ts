/**
 * Chat reset — drop a chat's conversation (session, history, turn meta,
 * cached readouts, pulse checkpoint) while keeping the chat itself.
 */

import { resetSession } from "../../storage/sessions.js";
import { clearHistory } from "../../storage/history.js";
import { resetPulseCheckpoint } from "../../core/background/pulse/pulse.js";
import { getBackendForChat } from "../../core/engine/backend-controller/index.js";
import { broadcastChatUpdated } from "./chat-wire.js";
import { emitSystem } from "./emit.js";
import type { NativeRuntime } from "./runtime.js";
import { clearTurnMeta } from "./turn-meta.js";

/**
 * Forget everything the conversation accumulated. Shared by the explicit
 * reset and a backend switch (sessions aren't portable across backends).
 */
export function wipeChatConversation(
  runtime: NativeRuntime,
  chatId: string,
): void {
  resetSession(chatId);
  clearHistory(chatId);
  clearTurnMeta(chatId);
  runtime.contextByChat.delete(chatId);
  runtime.queuedByChat.delete(chatId);
  resetPulseCheckpoint(chatId);
}

export function resetChat(runtime: NativeRuntime, chatId: string): boolean {
  const entry = runtime.chats.get(chatId);
  if (!entry) return false;
  // Full reset, matching /reset on the other frontends: session,
  // history (the app re-fetches its transcript from us), pulse
  // checkpoint, and any in-process backend memory. Warm the fresh
  // session in the background — the bridge handler is sync.
  wipeChatConversation(runtime, chatId);
  let backend = null;
  try {
    backend = getBackendForChat(chatId);
  } catch {
    // No pool binding — nothing to wipe or warm.
  }
  backend?.sessions?.resetChat?.(chatId);
  void backend?.sessions?.warmSession?.(chatId)?.catch(() => {});
  emitSystem(runtime, entry, "Session reset — starting a fresh conversation.");
  broadcastChatUpdated(runtime, entry);
  return true;
}
