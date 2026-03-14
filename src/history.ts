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
  /** Whether this message was a photo/doc/voice/video/animation (description only). */
  mediaType?: "photo" | "document" | "voice" | "sticker" | "video" | "animation";
  /** Telegram file_id for stickers, so Claude can reuse them. */
  stickerFileId?: string;
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
  const stickerTag = m.stickerFileId ? ` (sticker_file_id: ${m.stickerFileId})` : "";
  const time = new Date(m.timestamp).toISOString().slice(11, 16);
  return `[msg:${m.msgId} ${time}] ${m.senderName}${replyTag}${mediaTag}${stickerTag}: ${m.text}`;
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

/** List known users from chat history (name + ID). */
export function getKnownUsers(chatId: string): string {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return "No users seen yet.";
  const users = new Map<number, { name: string; lastSeen: number; messageCount: number }>();
  for (const m of history) {
    const existing = users.get(m.senderId);
    if (!existing || m.timestamp > existing.lastSeen) {
      users.set(m.senderId, {
        name: m.senderName,
        lastSeen: m.timestamp,
        messageCount: (existing?.messageCount ?? 0) + 1,
      });
    } else {
      existing.messageCount++;
    }
  }
  const lines = [...users.entries()]
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
    .map(([id, u]) => {
      const ago = formatTimeAgo(u.lastSeen);
      return `${u.name} (user_id: ${id}) — ${u.messageCount} msgs, last seen ${ago}`;
    });
  return lines.join("\n");
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Get the latest message ID in a chat's history buffer. */
export function getLatestMessageId(chatId: string): number | undefined {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return undefined;
  return history[history.length - 1].msgId;
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
