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

const MAX_HISTORY_PER_CHAT = 500;

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

function formatMessage(m: HistoryMessage): string {
  const replyTag = m.replyToMsgId ? ` (replying to msg:${m.replyToMsgId})` : "";
  const mediaTag = m.mediaType ? ` [${m.mediaType}]` : "";
  const time = new Date(m.timestamp).toISOString().slice(11, 16);
  return `[msg:${m.msgId} ${time}] ${m.senderName}${replyTag}${mediaTag}: ${m.text}`;
}

/** Get recent N messages formatted. */
export function getRecentFormatted(chatId: string, limit = 20): string {
  const messages = getRecentHistory(chatId, limit);
  if (messages.length === 0) return "No messages in history.";
  return messages.map(formatMessage).join("\n");
}

/** Search history by keyword (case-insensitive). */
export function searchHistory(chatId: string, query: string, limit = 20): string {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return "No messages in history.";
  const lower = query.toLowerCase();
  const matches = history.filter(
    (m) =>
      m.text.toLowerCase().includes(lower) ||
      m.senderName.toLowerCase().includes(lower),
  );
  if (matches.length === 0) return `No messages matching "${query}".`;
  return matches.slice(-limit).map(formatMessage).join("\n");
}

/** Get messages from a specific user. */
export function getMessagesByUser(chatId: string, userName: string, limit = 20): string {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return "No messages in history.";
  const lower = userName.toLowerCase();
  const matches = history.filter((m) => m.senderName.toLowerCase().includes(lower));
  if (matches.length === 0) return `No messages from "${userName}".`;
  return matches.slice(-limit).map(formatMessage).join("\n");
}

/** Get a specific message by ID. */
export function getMessageById(chatId: string, msgId: number): string {
  const history = chatHistories.get(chatId);
  if (!history) return "No messages in history.";
  const msg = history.find((m) => m.msgId === msgId);
  if (!msg) return `Message ${msgId} not found in recent history.`;
  return formatMessage(msg);
}

/** Get history stats. */
export function getHistoryStats(chatId: string): {
  totalMessages: number;
  uniqueUsers: number;
  oldestTimestamp: number;
  newestTimestamp: number;
} {
  const history = chatHistories.get(chatId) ?? [];
  const users = new Set(history.map((m) => m.senderId));
  return {
    totalMessages: history.length,
    uniqueUsers: users.size,
    oldestTimestamp: history[0]?.timestamp ?? 0,
    newestTimestamp: history[history.length - 1]?.timestamp ?? 0,
  };
}
