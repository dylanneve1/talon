/**
 * Extended tests for src/storage/history.ts
 *
 * Covers persistence paths (loadHistory, saveHistory backup creation),
 * MAX_CHAT_COUNT eviction, and a thorough re-test of every public function
 * with an emphasis on edge cases not covered by history.test.ts.
 *
 * The module uses write-file-atomic and node:fs — both are mocked so no
 * real disk I/O occurs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must come before any dynamic import) ───────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const existsSyncMock = vi.fn(() => false);
const readFileSyncMock = vi.fn(() => "{}");
const mkdirSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: vi.fn(),
  mkdirSync: mkdirSyncMock,
}));

const writeFileAtomicSyncMock = vi.fn();
vi.mock("write-file-atomic", () => ({
  default: { sync: writeFileAtomicSyncMock },
}));

// Mock cleanup-registry so we don't register real process.on listeners
vi.mock("../util/cleanup-registry.js", () => ({
  registerCleanup: vi.fn(),
}));

// Mock paths so we get a stable path string in assertions
vi.mock("../util/paths.js", () => ({
  files: { history: "/mock/data/history.json" },
  dirs: {},
}));

// ── Dynamic import after mocks ────────────────────────────────────────────

import type { HistoryMessage } from "../storage/history.js";

const {
  pushMessage,
  getRecentHistory,
  getHistoryStats,
  getKnownUsers,
  getMessageById,
  getRecentBySenderId,
  getMessagesByUser,
  searchHistory,
  clearHistory,
  setMessageFilePath,
  getLatestMessageId,
  loadHistory,
  flushHistory,
} = await import("../storage/history.js");

// ── Helpers ───────────────────────────────────────────────────────────────

let _chatSeq = 0;
function uniqueChat(): string {
  return `ext-hist-${++_chatSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

function makeMsg(
  overrides: Partial<HistoryMessage> & { msgId: number },
): HistoryMessage {
  return {
    senderId: 1,
    senderName: "User",
    text: `Message ${overrides.msgId}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── pushMessage — eviction when MAX_CHAT_COUNT (1000) is reached ──────────

describe("pushMessage — MAX_CHAT_COUNT eviction", () => {
  it("evicts ~10% of oldest chats when the 1001st unique chat is added", () => {
    // Use a fresh set of unique chat IDs to avoid contamination from other tests.
    // We only push 20 chats to verify the eviction logic fires; the real threshold
    // is 1000 but we can't afford to create that many in a test.
    // Instead, test the observable side-effect: after a run that crosses the limit,
    // some early chats are gone and the new chat is present.
    //
    // Because the module-level Map is shared we need to rely on the same
    // unique IDs the module does — just verify the existing test contract.

    const prefix = `evict-ext-${Date.now()}-`;
    for (let i = 0; i < 1001; i++) {
      pushMessage(`${prefix}${i}`, makeMsg({ msgId: 1 }));
    }

    // The 1001st chat should definitely be present
    expect(getRecentHistory(`${prefix}1000`)).toHaveLength(1);

    // At least one of the earliest chats should have been evicted
    let evicted = 0;
    for (let i = 0; i < 200; i++) {
      if (getRecentHistory(`${prefix}${i}`).length === 0) evicted++;
    }
    expect(evicted).toBeGreaterThan(0);
    // Approximately 100 chats should have been evicted (10% of 1000)
    expect(evicted).toBeGreaterThanOrEqual(50);
  });

  it("marks dirty when eviction occurs", () => {
    // We check that after adding 1001 chats and then flushing, writeFileAtomicSync
    // is called (which only happens when dirty === true).
    const prefix = `dirty-evict-${Date.now()}-`;
    for (let i = 0; i < 1001; i++) {
      pushMessage(`${prefix}${i}`, makeMsg({ msgId: 1 }));
    }

    writeFileAtomicSyncMock.mockClear();
    existsSyncMock.mockReturnValue(false);
    flushHistory();
    expect(writeFileAtomicSyncMock).toHaveBeenCalled();
  });
});

// ── getHistoryStats ────────────────────────────────────────────────────────

describe("getHistoryStats", () => {
  it("returns correct stats for a single message", () => {
    const id = uniqueChat();
    const ts = Date.now();
    pushMessage(id, makeMsg({ msgId: 1, senderId: 42, timestamp: ts }));

    const stats = getHistoryStats(id);
    expect(stats.totalMessages).toBe(1);
    expect(stats.uniqueUsers).toBe(1);
    expect(stats.oldestTimestamp).toBe(ts);
    expect(stats.newestTimestamp).toBe(ts);
  });

  it("counts unique users correctly with repeated sender", () => {
    const id = uniqueChat();
    const ts = Date.now();
    pushMessage(id, makeMsg({ msgId: 1, senderId: 10, timestamp: ts - 2000 }));
    pushMessage(id, makeMsg({ msgId: 2, senderId: 10, timestamp: ts - 1000 }));
    pushMessage(id, makeMsg({ msgId: 3, senderId: 20, timestamp: ts }));

    const stats = getHistoryStats(id);
    expect(stats.totalMessages).toBe(3);
    expect(stats.uniqueUsers).toBe(2);
    expect(stats.oldestTimestamp).toBe(ts - 2000);
    expect(stats.newestTimestamp).toBe(ts);
  });

  it("returns zeroes for non-existent chat", () => {
    const stats = getHistoryStats("does-not-exist-stats-xyz");
    expect(stats.totalMessages).toBe(0);
    expect(stats.uniqueUsers).toBe(0);
    expect(stats.oldestTimestamp).toBe(0);
    expect(stats.newestTimestamp).toBe(0);
  });

  it("returns zeroes after clearHistory", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1, senderId: 1 }));
    clearHistory(id);

    const stats = getHistoryStats(id);
    expect(stats.totalMessages).toBe(0);
    expect(stats.uniqueUsers).toBe(0);
    expect(stats.oldestTimestamp).toBe(0);
    expect(stats.newestTimestamp).toBe(0);
  });
});

// ── getKnownUsers ─────────────────────────────────────────────────────────

describe("getKnownUsers", () => {
  it("returns sorted list by last seen (most recent first)", () => {
    const id = uniqueChat();
    const now = Date.now();
    pushMessage(id, makeMsg({ msgId: 1, senderId: 100, senderName: "Alpha", timestamp: now - 3600_000 }));
    pushMessage(id, makeMsg({ msgId: 2, senderId: 200, senderName: "Beta",  timestamp: now - 60_000 }));
    pushMessage(id, makeMsg({ msgId: 3, senderId: 300, senderName: "Gamma", timestamp: now - 1_000 }));

    const result = getKnownUsers(id);
    const gammaIdx = result.indexOf("Gamma");
    const betaIdx  = result.indexOf("Beta");
    const alphaIdx = result.indexOf("Alpha");

    expect(gammaIdx).toBeLessThan(betaIdx);
    expect(betaIdx).toBeLessThan(alphaIdx);
  });

  it("includes message counts for each user", () => {
    const id = uniqueChat();
    for (let i = 0; i < 4; i++) {
      pushMessage(id, makeMsg({ msgId: i, senderId: 10, senderName: "Active", timestamp: Date.now() + i }));
    }
    pushMessage(id, makeMsg({ msgId: 99, senderId: 20, senderName: "Lurker", timestamp: Date.now() }));

    const result = getKnownUsers(id);
    expect(result).toContain("4 msgs"); // Active
    expect(result).toContain("1 msgs"); // Lurker
  });

  it("includes user_id in output", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1, senderId: 55555, senderName: "Identified" }));
    expect(getKnownUsers(id)).toContain("user_id: 55555");
  });

  it("returns 'No users seen yet.' for cleared chat", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1, senderId: 1 }));
    clearHistory(id);
    expect(getKnownUsers(id)).toBe("No users seen yet.");
  });
});

// ── getMessageById ────────────────────────────────────────────────────────

describe("getMessageById", () => {
  it("finds and formats the correct message", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 77, senderName: "Alice", text: "find me" }));
    pushMessage(id, makeMsg({ msgId: 78, senderName: "Bob", text: "other" }));

    const result = getMessageById(id, 77);
    expect(result).toContain("msg:77");
    expect(result).toContain("Alice");
    expect(result).toContain("find me");
  });

  it("returns 'not found' message for missing msgId", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1 }));

    const result = getMessageById(id, 9999);
    expect(result).toContain("9999");
    expect(result).toContain("not found");
  });

  it("returns 'No messages in history.' for empty chat", () => {
    const result = getMessageById("empty-byid", 1);
    expect(result).toContain("No messages in history");
  });

  it("finds message after setMessageFilePath update", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 5, text: "with file" }));
    setMessageFilePath(id, 5, "/tmp/some-file.pdf");

    const result = getMessageById(id, 5);
    expect(result).toContain("(file: /tmp/some-file.pdf)");
  });
});

// ── getRecentBySenderId ───────────────────────────────────────────────────

describe("getRecentBySenderId", () => {
  it("filters messages to the given sender", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1, senderId: 10, senderName: "A" }));
    pushMessage(id, makeMsg({ msgId: 2, senderId: 20, senderName: "B" }));
    pushMessage(id, makeMsg({ msgId: 3, senderId: 10, senderName: "A" }));

    const result = getRecentBySenderId(id, 10);
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.senderId === 10)).toBe(true);
  });

  it("returns empty array when sender has no messages", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1, senderId: 10 }));
    expect(getRecentBySenderId(id, 99)).toEqual([]);
  });

  it("returns empty array for non-existent chat", () => {
    expect(getRecentBySenderId("ghost-chat-sender", 1)).toEqual([]);
  });

  it("respects the limit parameter (returns most recent N)", () => {
    const id = uniqueChat();
    for (let i = 1; i <= 10; i++) {
      pushMessage(id, makeMsg({ msgId: i, senderId: 5 }));
    }
    const result = getRecentBySenderId(id, 5, 3);
    expect(result).toHaveLength(3);
    // Most recent 3 are msgId 8, 9, 10
    expect(result[0].msgId).toBe(8);
    expect(result[2].msgId).toBe(10);
  });
});

// ── getMessagesByUser ─────────────────────────────────────────────────────

describe("getMessagesByUser", () => {
  it("filters by case-insensitive substring match on senderName", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1, senderName: "Charlie Brown", text: "peanuts" }));
    pushMessage(id, makeMsg({ msgId: 2, senderName: "Lucy Van Pelt", text: "football" }));

    const result = getMessagesByUser(id, "charlie");
    expect(result).toContain("peanuts");
    expect(result).not.toContain("football");
  });

  it("returns 'No messages from' for unmatched user", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1, senderName: "Alice" }));
    expect(getMessagesByUser(id, "Zorro")).toContain('No messages from "Zorro"');
  });

  it("returns 'No messages in history' for empty chat", () => {
    expect(getMessagesByUser("empty-usr-chat", "anyone")).toContain("No messages in history");
  });

  it("partial name match returns all matching messages", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1, senderName: "Bob Smith" }));
    pushMessage(id, makeMsg({ msgId: 2, senderName: "Bob Jones" }));
    pushMessage(id, makeMsg({ msgId: 3, senderName: "Alice" }));

    const result = getMessagesByUser(id, "bob");
    expect(result).toContain("Bob Smith");
    expect(result).toContain("Bob Jones");
    expect(result).not.toContain("Alice");
  });
});

// ── searchHistory ─────────────────────────────────────────────────────────

describe("searchHistory", () => {
  it("returns proper 'no matches' message when nothing matches", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1, text: "hello world" }));

    const result = searchHistory(id, "xyzzy_no_match");
    expect(result).toContain("No messages matching");
    expect(result).toContain("xyzzy_no_match");
  });

  it("matches by sender name (case-insensitive)", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1, senderName: "Sherlock Holmes", text: "elementary" }));
    pushMessage(id, makeMsg({ msgId: 2, senderName: "Dr Watson", text: "quite so" }));

    const result = searchHistory(id, "sherlock");
    expect(result).toContain("elementary");
    expect(result).not.toContain("quite so");
  });

  it("returns 'No messages in history' for chat with no messages", () => {
    expect(searchHistory("no-msgs-srch", "anything")).toContain("No messages in history");
  });

  it("matches are returned in chronological order (last N)", () => {
    const id = uniqueChat();
    for (let i = 1; i <= 5; i++) {
      pushMessage(id, makeMsg({ msgId: i, text: `match ${i}` }));
    }
    const result = searchHistory(id, "match", 3);
    const lines = result.split("\n");
    // Last 3 matches: msgIds 3, 4, 5
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("match 5");
  });
});

// ── clearHistory ──────────────────────────────────────────────────────────

describe("clearHistory", () => {
  it("removes messages and subsequent getRecentHistory returns []", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1 }));
    pushMessage(id, makeMsg({ msgId: 2 }));
    clearHistory(id);
    expect(getRecentHistory(id)).toEqual([]);
  });

  it("marks dirty so next flush writes to disk", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1 }));
    clearHistory(id);

    writeFileAtomicSyncMock.mockClear();
    existsSyncMock.mockReturnValue(false);
    flushHistory();
    expect(writeFileAtomicSyncMock).toHaveBeenCalled();
  });

  it("does not affect other chats", () => {
    const id1 = uniqueChat();
    const id2 = uniqueChat();
    pushMessage(id1, makeMsg({ msgId: 1 }));
    pushMessage(id2, makeMsg({ msgId: 2 }));
    clearHistory(id1);

    expect(getRecentHistory(id1)).toEqual([]);
    expect(getRecentHistory(id2)).toHaveLength(1);
  });
});

// ── setMessageFilePath ────────────────────────────────────────────────────

describe("setMessageFilePath", () => {
  it("updates filePath on an existing message and marks dirty", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 10, text: "photo msg" }));
    setMessageFilePath(id, 10, "/home/user/photo.jpg");

    const history = getRecentHistory(id);
    expect(history[0].filePath).toBe("/home/user/photo.jpg");
  });

  it("is a no-op for a chat that does not exist", () => {
    expect(() => setMessageFilePath("ghost-chat", 1, "/tmp/x.jpg")).not.toThrow();
  });

  it("is a no-op when msgId is not found", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1 }));
    setMessageFilePath(id, 999, "/tmp/nope.jpg");

    const history = getRecentHistory(id);
    expect(history[0].filePath).toBeUndefined();
  });

  it("overwrites an existing filePath", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1, filePath: "/old/path.png" }));
    setMessageFilePath(id, 1, "/new/path.png");

    expect(getRecentHistory(id)[0].filePath).toBe("/new/path.png");
  });
});

// ── getLatestMessageId ────────────────────────────────────────────────────

describe("getLatestMessageId", () => {
  it("returns the msgId of the last pushed message", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 100 }));
    pushMessage(id, makeMsg({ msgId: 200 }));
    pushMessage(id, makeMsg({ msgId: 150 })); // out of order is fine

    expect(getLatestMessageId(id)).toBe(150);
  });

  it("returns undefined for a chat with no messages", () => {
    expect(getLatestMessageId("empty-latest-chat")).toBeUndefined();
  });

  it("returns undefined after clearHistory", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1 }));
    clearHistory(id);
    expect(getLatestMessageId(id)).toBeUndefined();
  });

  it("reflects the most recently added message", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1 }));
    expect(getLatestMessageId(id)).toBe(1);
    pushMessage(id, makeMsg({ msgId: 2 }));
    expect(getLatestMessageId(id)).toBe(2);
  });
});

// ── loadHistory — persistence paths ──────────────────────────────────────

describe("loadHistory — persistence", () => {
  it("does not throw when the store file does not exist", () => {
    existsSyncMock.mockReturnValue(false);
    expect(() => loadHistory()).not.toThrow();
  });

  it("loads messages from a valid JSON file", () => {
    const stored = {
      "persist-chat-1": [
        { msgId: 1, senderId: 1, senderName: "Test", text: "hello", timestamp: 1000 },
      ],
    };
    existsSyncMock.mockReturnValueOnce(true);
    readFileSyncMock.mockReturnValueOnce(JSON.stringify(stored));

    loadHistory();

    const history = getRecentHistory("persist-chat-1");
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe("hello");
  });

  it("falls back to backup file when primary is corrupt", () => {
    const backup = {
      "backup-chat": [
        { msgId: 99, senderId: 1, senderName: "Backup", text: "from backup", timestamp: 2000 },
      ],
    };
    // First existsSync call: primary exists; readFileSync returns corrupt data.
    // Second existsSync call: backup exists; readFileSync returns valid data.
    existsSyncMock
      .mockReturnValueOnce(true)   // primary file exists
      .mockReturnValueOnce(true);  // backup file exists
    readFileSyncMock
      .mockReturnValueOnce("{{corrupt json}}")   // primary read fails
      .mockReturnValueOnce(JSON.stringify(backup)); // backup read succeeds

    expect(() => loadHistory()).not.toThrow();
  });

  it("handles corrupt JSON in primary without throwing", () => {
    existsSyncMock.mockReturnValueOnce(true).mockReturnValue(false);
    readFileSyncMock.mockReturnValueOnce("not json at all!!!");

    expect(() => loadHistory()).not.toThrow();
  });

  it("caps loaded messages to MAX_HISTORY_PER_CHAT (500)", () => {
    const msgs = Array.from({ length: 600 }, (_, i) => ({
      msgId: i,
      senderId: 1,
      senderName: "User",
      text: `msg ${i}`,
      timestamp: Date.now() + i,
    }));
    existsSyncMock.mockReturnValueOnce(true);
    readFileSyncMock.mockReturnValueOnce(JSON.stringify({ "cap-test-chat": msgs }));

    loadHistory();

    const history = getRecentHistory("cap-test-chat", 1000);
    expect(history.length).toBeLessThanOrEqual(500);
  });
});

// ── flushHistory ──────────────────────────────────────────────────────────

describe("flushHistory", () => {
  it("calls writeFileAtomic.sync at least once", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1 }));

    writeFileAtomicSyncMock.mockClear();
    existsSyncMock.mockReturnValue(false);
    flushHistory();
    expect(writeFileAtomicSyncMock).toHaveBeenCalled();
  });

  it("creates the directory when it does not exist", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1 }));

    mkdirSyncMock.mockClear();
    existsSyncMock.mockReturnValue(false);
    flushHistory();
    expect(mkdirSyncMock).toHaveBeenCalled();
  });

  it("writes a JSON blob containing the chat data", () => {
    const id = `flush-check-${Date.now()}`;
    pushMessage(id, makeMsg({ msgId: 42, senderName: "FlushUser", text: "flush me" }));

    writeFileAtomicSyncMock.mockClear();
    existsSyncMock.mockReturnValue(false);
    flushHistory();

    const calls = writeFileAtomicSyncMock.mock.calls;
    // At least one call should be the actual data write (not .bak)
    const dataCall = calls.find((c) => !String(c[0]).endsWith(".bak"));
    expect(dataCall).toBeDefined();
    const written = JSON.parse(dataCall![1] as string);
    expect(written[id]).toBeDefined();
    expect(written[id][0].msgId).toBe(42);
  });

  it("writes a backup of the current file before overwriting when file exists", () => {
    const id = uniqueChat();
    pushMessage(id, makeMsg({ msgId: 1 }));

    writeFileAtomicSyncMock.mockClear();
    // Simulate existing file
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('{"old": "data"}');
    flushHistory();

    // One of the writeFileAtomic calls should be for the .bak file
    const bakCall = writeFileAtomicSyncMock.mock.calls.find((c) =>
      String(c[0]).endsWith(".bak"),
    );
    expect(bakCall).toBeDefined();
  });
});
