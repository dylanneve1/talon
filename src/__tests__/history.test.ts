import { describe, it, expect, beforeEach } from "vitest";
import {
  pushMessage,
  getRecentHistory,
  searchHistory,
  getMessagesByUser,
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
});
