/**
 * Group message history buffer. Stores recent messages from all users
 * so Claude has full conversation context even for messages that didn't
 * trigger the bot. Messages are kept in memory with a configurable cap.
 */

export type HistoryMessage = {
  msgId: number;
  senderId: number;
  senderName: string;
  text: string;
  replyToMsgId?: number;
  timestamp: number;
  /** Whether this message was a photo/doc/voice (description only). */
  mediaType?: "photo" | "document" | "voice" | "sticker";
};

const MAX_HISTORY_PER_CHAT = 100;

const chatHistories = new Map<string, HistoryMessage[]>();

export function pushMessage(chatId: string, msg: HistoryMessage): void {
  let history = chatHistories.get(chatId);
  if (!history) {
    history = [];
    chatHistories.set(chatId, history);
  }
  history.push(msg);
  // Trim to max
  if (history.length > MAX_HISTORY_PER_CHAT) {
    history.splice(0, history.length - MAX_HISTORY_PER_CHAT);
  }
}

export function getRecentHistory(chatId: string, limit = 50): HistoryMessage[] {
  const history = chatHistories.get(chatId);
  if (!history) return [];
  return history.slice(-limit);
}

export function clearHistory(chatId: string): void {
  chatHistories.delete(chatId);
}

/**
 * Format recent history as context for Claude's prompt.
 * Includes message IDs so Claude can reference/reply to specific messages.
 */
export function formatHistoryContext(chatId: string, limit = 30): string {
  const messages = getRecentHistory(chatId, limit);
  if (messages.length === 0) return "";

  const lines = messages.map((m) => {
    const replyTag = m.replyToMsgId ? ` (replying to msg:${m.replyToMsgId})` : "";
    const mediaTag = m.mediaType ? ` [${m.mediaType}]` : "";
    return `[msg:${m.msgId}] ${m.senderName}${replyTag}${mediaTag}: ${m.text}`;
  });

  return (
    "--- Recent chat history (use msg IDs with reply_to_message_id or react) ---\n" +
    lines.join("\n") +
    "\n--- End history ---"
  );
}
