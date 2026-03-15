import { describe, it, expect, beforeEach } from "vitest";
import {
  pushMessage,
  getRecentHistory,
  searchHistory,
  getMessagesByUser,
  getKnownUsers,
  getRecentBySenderId,
  getLatestMessageId,
  getRecentFormatted,
  getMessageById,
  getHistoryStats,
  clearHistory,
  type HistoryMessage,
} from "../storage/history.js";

function makeMsg(
  overrides: Partial<HistoryMessage> & { msgId: number },
): HistoryMessage {
  return {
    senderId: 1,
    senderName: "TestUser",
    text: `Message ${overrides.msgId}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("history", () => {
  const chatId = () => `test-${Math.random().toString(36).slice(2)}`;

  describe("pushMessage", () => {
    it("adds a message to the history buffer", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1 }));
      const history = getRecentHistory(id);
      expect(history).toHaveLength(1);
      expect(history[0].msgId).toBe(1);
    });

    it("adds multiple messages in order", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1 }));
      pushMessage(id, makeMsg({ msgId: 2 }));
      pushMessage(id, makeMsg({ msgId: 3 }));
      const history = getRecentHistory(id, 100);
      expect(history).toHaveLength(3);
      expect(history[0].msgId).toBe(1);
      expect(history[2].msgId).toBe(3);
    });

    it("caps buffer at MAX_HISTORY_PER_CHAT (500)", () => {
      const id = chatId();
      for (let i = 0; i < 550; i++) {
        pushMessage(id, makeMsg({ msgId: i }));
      }
      const history = getRecentHistory(id, 1000);
      expect(history).toHaveLength(500);
      // First message should be 50 (the oldest surviving after trim)
      expect(history[0].msgId).toBe(50);
      expect(history[499].msgId).toBe(549);
    });
  });

  describe("getRecentHistory", () => {
    it("returns empty array for unknown chat", () => {
      expect(getRecentHistory("nonexistent-chat")).toEqual([]);
    });

    it("respects the limit parameter", () => {
      const id = chatId();
      for (let i = 0; i < 20; i++) {
        pushMessage(id, makeMsg({ msgId: i }));
      }
      const history = getRecentHistory(id, 5);
      expect(history).toHaveLength(5);
      // Should return the 5 most recent
      expect(history[0].msgId).toBe(15);
      expect(history[4].msgId).toBe(19);
    });

    it("defaults to 50 messages", () => {
      const id = chatId();
      for (let i = 0; i < 100; i++) {
        pushMessage(id, makeMsg({ msgId: i }));
      }
      const history = getRecentHistory(id);
      expect(history).toHaveLength(50);
    });
  });

  describe("searchHistory", () => {
    it("finds messages matching text (case-insensitive)", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1, text: "Hello world" }));
      pushMessage(id, makeMsg({ msgId: 2, text: "Goodbye world" }));
      pushMessage(id, makeMsg({ msgId: 3, text: "Something else" }));

      const result = searchHistory(id, "world");
      expect(result).toContain("Hello world");
      expect(result).toContain("Goodbye world");
      expect(result).not.toContain("Something else");
    });

    it("finds messages matching sender name", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1, senderName: "Alice", text: "hi" }));
      pushMessage(id, makeMsg({ msgId: 2, senderName: "Bob", text: "hello" }));

      const result = searchHistory(id, "alice");
      expect(result).toContain("Alice");
      expect(result).not.toContain("Bob");
    });

    it("returns 'No messages' for empty history", () => {
      const result = searchHistory("empty-chat", "test");
      expect(result).toContain("No messages in history");
    });

    it("returns 'No messages matching' when no results", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1, text: "hello" }));
      const result = searchHistory(id, "xyzzy");
      expect(result).toContain("No messages matching");
    });
  });

  describe("getMessagesByUser", () => {
    it("filters messages by user name (case-insensitive)", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({ msgId: 1, senderName: "Alice", text: "msg from alice" }),
      );
      pushMessage(
        id,
        makeMsg({ msgId: 2, senderName: "Bob", text: "msg from bob" }),
      );
      pushMessage(
        id,
        makeMsg({ msgId: 3, senderName: "Alice", text: "another from alice" }),
      );

      const result = getMessagesByUser(id, "alice");
      expect(result).toContain("msg from alice");
      expect(result).toContain("another from alice");
      expect(result).not.toContain("msg from bob");
    });

    it("returns 'No messages from' when user not found", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1, senderName: "Alice", text: "hi" }));
      const result = getMessagesByUser(id, "Charlie");
      expect(result).toContain('No messages from "Charlie"');
    });

    it("returns 'No messages in history' for empty chat", () => {
      const result = getMessagesByUser("empty-chat-users", "anyone");
      expect(result).toContain("No messages in history");
    });
  });

  describe("clearHistory", () => {
    it("empties the history buffer for a chat", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1 }));
      pushMessage(id, makeMsg({ msgId: 2 }));
      expect(getRecentHistory(id)).toHaveLength(2);

      clearHistory(id);
      expect(getRecentHistory(id)).toEqual([]);
    });

    it("does not affect other chats", () => {
      const id1 = chatId();
      const id2 = chatId();
      pushMessage(id1, makeMsg({ msgId: 1 }));
      pushMessage(id2, makeMsg({ msgId: 2 }));

      clearHistory(id1);
      expect(getRecentHistory(id1)).toEqual([]);
      expect(getRecentHistory(id2)).toHaveLength(1);
    });
  });

  describe("getKnownUsers", () => {
    it("returns formatted user list with message counts", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({ msgId: 1, senderId: 100, senderName: "Alice", text: "hi" }),
      );
      pushMessage(
        id,
        makeMsg({ msgId: 2, senderId: 200, senderName: "Bob", text: "hey" }),
      );
      pushMessage(
        id,
        makeMsg({
          msgId: 3,
          senderId: 100,
          senderName: "Alice",
          text: "how are you",
        }),
      );

      const result = getKnownUsers(id);
      expect(result).toContain("Alice");
      expect(result).toContain("Bob");
      expect(result).toContain("user_id: 100");
      expect(result).toContain("user_id: 200");
      expect(result).toContain("2 msgs"); // Alice has 2 messages
      expect(result).toContain("1 msgs"); // Bob has 1 message
    });

    it("returns 'No users seen yet.' for empty chat", () => {
      const result = getKnownUsers("empty-users-chat");
      expect(result).toContain("No users seen yet.");
    });

    it("returns 'No users seen yet.' for nonexistent chat", () => {
      const result = getKnownUsers("nonexistent-chat-xyz");
      expect(result).toContain("No users seen yet.");
    });
  });

  describe("getRecentBySenderId", () => {
    it("returns messages from a specific sender", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({ msgId: 1, senderId: 100, senderName: "Alice" }),
      );
      pushMessage(
        id,
        makeMsg({ msgId: 2, senderId: 200, senderName: "Bob" }),
      );
      pushMessage(
        id,
        makeMsg({ msgId: 3, senderId: 100, senderName: "Alice" }),
      );
      pushMessage(
        id,
        makeMsg({ msgId: 4, senderId: 200, senderName: "Bob" }),
      );

      const result = getRecentBySenderId(id, 100);
      expect(result).toHaveLength(2);
      expect(result[0].msgId).toBe(1);
      expect(result[1].msgId).toBe(3);
    });

    it("returns empty array for unknown sender", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({ msgId: 1, senderId: 100, senderName: "Alice" }),
      );
      const result = getRecentBySenderId(id, 999);
      expect(result).toEqual([]);
    });

    it("respects limit parameter", () => {
      const id = chatId();
      for (let i = 0; i < 10; i++) {
        pushMessage(
          id,
          makeMsg({ msgId: i, senderId: 100, senderName: "Alice" }),
        );
      }
      const result = getRecentBySenderId(id, 100, 3);
      expect(result).toHaveLength(3);
      // Should be the 3 most recent
      expect(result[0].msgId).toBe(7);
      expect(result[2].msgId).toBe(9);
    });

    it("returns empty array for nonexistent chat", () => {
      const result = getRecentBySenderId("nonexistent-sender-chat", 100);
      expect(result).toEqual([]);
    });
  });

  describe("getLatestMessageId", () => {
    it("returns the ID of the most recent message", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 10 }));
      pushMessage(id, makeMsg({ msgId: 20 }));
      pushMessage(id, makeMsg({ msgId: 30 }));

      expect(getLatestMessageId(id)).toBe(30);
    });

    it("returns undefined for empty/nonexistent chat", () => {
      expect(getLatestMessageId("nonexistent-latest")).toBeUndefined();
    });
  });

  describe("getRecentFormatted", () => {
    it("returns formatted message strings", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderName: "Alice",
          text: "Hello there!",
          timestamp: new Date("2025-01-15T10:30:00Z").getTime(),
        }),
      );

      const result = getRecentFormatted(id, 5);
      expect(result).toContain("Alice");
      expect(result).toContain("Hello there!");
      expect(result).toContain("msg:1");
    });

    it("returns 'No messages in history.' for empty chat", () => {
      const result = getRecentFormatted("empty-formatted-chat");
      expect(result).toBe("No messages in history.");
    });

    it("includes media type tags", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderName: "Bob",
          text: "a photo",
          mediaType: "photo",
        }),
      );

      const result = getRecentFormatted(id, 5);
      expect(result).toContain("[photo]");
    });

    it("includes sticker file_id", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 1,
          senderName: "Bob",
          text: "sticker",
          mediaType: "sticker",
          stickerFileId: "CAACAgIAAxk",
        }),
      );

      const result = getRecentFormatted(id, 5);
      expect(result).toContain("sticker_file_id: CAACAgIAAxk");
    });

    it("includes reply tag", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({
          msgId: 2,
          senderName: "Alice",
          text: "replying",
          replyToMsgId: 1,
        }),
      );

      const result = getRecentFormatted(id, 5);
      expect(result).toContain("replying to msg:1");
    });
  });

  describe("getMessageById", () => {
    it("returns formatted message when found", () => {
      const id = chatId();
      pushMessage(
        id,
        makeMsg({ msgId: 42, senderName: "Alice", text: "specific message" }),
      );
      pushMessage(id, makeMsg({ msgId: 43, senderName: "Bob", text: "other" }));

      const result = getMessageById(id, 42);
      expect(result).toContain("Alice");
      expect(result).toContain("specific message");
      expect(result).toContain("msg:42");
    });

    it("returns 'not found' for missing message", () => {
      const id = chatId();
      pushMessage(id, makeMsg({ msgId: 1 }));
      const result = getMessageById(id, 999);
      expect(result).toContain("Message 999 not found");
    });

    it("returns 'No messages' for empty chat", () => {
      const result = getMessageById("empty-by-id-chat", 1);
      expect(result).toContain("No messages in history");
    });
  });

  describe("getHistoryStats", () => {
    it("returns correct stats", () => {
      const id = chatId();
      const ts1 = Date.now() - 10000;
      const ts2 = Date.now() - 5000;
      pushMessage(
        id,
        makeMsg({ msgId: 1, senderId: 100, timestamp: ts1 }),
      );
      pushMessage(
        id,
        makeMsg({ msgId: 2, senderId: 200, timestamp: ts2 }),
      );

      const stats = getHistoryStats(id);
      expect(stats.totalMessages).toBe(2);
      expect(stats.uniqueUsers).toBe(2);
      expect(stats.oldestTimestamp).toBe(ts1);
      expect(stats.newestTimestamp).toBe(ts2);
    });

    it("returns zeroes for empty chat", () => {
      const stats = getHistoryStats("nonexistent-stats-chat");
      expect(stats.totalMessages).toBe(0);
      expect(stats.uniqueUsers).toBe(0);
      expect(stats.oldestTimestamp).toBe(0);
      expect(stats.newestTimestamp).toBe(0);
    });
  });

  describe("chat eviction", () => {
    it("evicts oldest chats when exceeding MAX_CHAT_COUNT (1000)", () => {
      // Push messages for 1001 unique chats
      for (let i = 0; i < 1001; i++) {
        pushMessage(`evict-chat-${i}`, makeMsg({ msgId: 1 }));
      }
      // The first ~100 chats (10%) should have been evicted
      // The last chat should still exist
      expect(getRecentHistory("evict-chat-1000")).toHaveLength(1);
      // Some early chats should have been evicted
      let evictedCount = 0;
      for (let i = 0; i < 100; i++) {
        if (getRecentHistory(`evict-chat-${i}`).length === 0) {
          evictedCount++;
        }
      }
      expect(evictedCount).toBeGreaterThan(0);
    });
  });
});
