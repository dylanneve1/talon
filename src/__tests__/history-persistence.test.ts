import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const existsSyncMock = vi.fn(() => false);
const readFileSyncMock = vi.fn(() => "{}");
const mkdirSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
}));

const writeFileSyncMock = vi.fn();

vi.mock("write-file-atomic", () => ({
  default: { sync: (...args: unknown[]) => writeFileSyncMock(...args) },
}));

const {
  loadHistory,
  flushHistory,
  pushMessage,
  getRecentHistory,
} = await import("../storage/history.js");

describe("history persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loadHistory", () => {
    it("loads history from a JSON file when it exists", () => {
      const data: Record<string, Array<{ msgId: number; senderId: number; senderName: string; text: string; timestamp: number }>> = {
        "chat-1": [
          { msgId: 1, senderId: 100, senderName: "Alice", text: "hello", timestamp: 1000 },
          { msgId: 2, senderId: 200, senderName: "Bob", text: "hi", timestamp: 2000 },
        ],
      };
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue(JSON.stringify(data));

      loadHistory();

      const history = getRecentHistory("chat-1");
      expect(history).toHaveLength(2);
      expect(history[0].senderName).toBe("Alice");
      expect(history[1].senderName).toBe("Bob");
    });

    it("trims loaded history to MAX_HISTORY_PER_CHAT (500)", () => {
      const msgs = Array.from({ length: 600 }, (_, i) => ({
        msgId: i,
        senderId: 1,
        senderName: "User",
        text: `msg ${i}`,
        timestamp: i * 1000,
      }));
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue(JSON.stringify({ "trim-chat": msgs }));

      loadHistory();

      const history = getRecentHistory("trim-chat", 1000);
      expect(history).toHaveLength(500);
      // Should keep the last 500 messages (100-599)
      expect(history[0].msgId).toBe(100);
    });

    it("does nothing when store file does not exist", () => {
      existsSyncMock.mockReturnValue(false);
      // Should not throw
      expect(() => loadHistory()).not.toThrow();
    });

    it("handles JSON parse errors gracefully (starts fresh)", () => {
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue("not valid json{{{");

      // Should not throw
      expect(() => loadHistory()).not.toThrow();
    });

    it("loads multiple chats", () => {
      const data = {
        "chat-a": [{ msgId: 1, senderId: 1, senderName: "A", text: "a", timestamp: 1 }],
        "chat-b": [{ msgId: 2, senderId: 2, senderName: "B", text: "b", timestamp: 2 }],
        "chat-c": [{ msgId: 3, senderId: 3, senderName: "C", text: "c", timestamp: 3 }],
      };
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue(JSON.stringify(data));

      loadHistory();

      expect(getRecentHistory("chat-a")).toHaveLength(1);
      expect(getRecentHistory("chat-b")).toHaveLength(1);
      expect(getRecentHistory("chat-c")).toHaveLength(1);
    });
  });

  describe("flushHistory", () => {
    it("writes history to disk", () => {
      const id = `flush-test-${Date.now()}`;
      pushMessage(id, {
        msgId: 1,
        senderId: 1,
        senderName: "TestUser",
        text: "flush test",
        timestamp: Date.now(),
      });

      // Make existsSync return true for the workspace dir check
      existsSyncMock.mockReturnValue(true);

      flushHistory();

      expect(writeFileSyncMock).toHaveBeenCalled();
      // Last write call is the actual data (earlier calls may be .bak backups)
      const lastCall = writeFileSyncMock.mock.calls[writeFileSyncMock.mock.calls.length - 1];
      const writtenData = lastCall[1] as string;
      const parsed = JSON.parse(writtenData.trim());
      expect(parsed[id]).toBeDefined();
      expect(parsed[id][0].text).toBe("flush test");
    });

    it("creates workspace directory if it does not exist", () => {
      const id = `flush-mkdir-${Date.now()}`;
      pushMessage(id, {
        msgId: 1,
        senderId: 1,
        senderName: "TestUser",
        text: "test",
        timestamp: Date.now(),
      });

      // First call (dir check) returns false, triggering mkdirSync
      existsSyncMock.mockReturnValue(false);

      flushHistory();

      expect(mkdirSyncMock).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it("handles write errors gracefully (line 96 TRUE branch: Error thrown on data write)", () => {
      const id = `flush-err-${Date.now()}`;
      pushMessage(id, {
        msgId: 1,
        senderId: 1,
        senderName: "TestUser",
        text: "test",
        timestamp: Date.now(),
      });

      // existsSync=false skips the .bak write so the Error is thrown on the actual data write
      existsSyncMock.mockReturnValue(false);
      writeFileSyncMock.mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      // Should not throw
      expect(() => flushHistory()).not.toThrow();
    });
  });
});

describe("history — non-Error throw coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saveHistory covers String(err) when writeFileAtomic throws a non-Error", async () => {
    const { logError } = await import("../util/log.js");
    vi.mocked(logError).mockClear();

    const id = `flush-non-error-${Date.now()}`;
    pushMessage(id, {
      msgId: 1,
      senderId: 1,
      senderName: "TestUser",
      text: "test non-error throw",
      timestamp: Date.now(),
    });

    existsSyncMock.mockReturnValue(false); // no backup attempt
    // Throw a plain string (non-Error) to cover `err instanceof Error ? ... : err`
    writeFileSyncMock.mockImplementation(() => { throw "disk quota string"; }); // eslint-disable-line @typescript-eslint/no-throw-literal

    expect(() => flushHistory()).not.toThrow();
    expect(vi.mocked(logError)).toHaveBeenCalled();

    writeFileSyncMock.mockReset();
  });
});
