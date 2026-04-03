import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const existsSyncMock = vi.fn(() => false);
const readFileSyncMock = vi.fn(() => "[]");
const mkdirSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
  unlinkSync: unlinkSyncMock,
}));

const writeFileSyncMock = vi.fn();

vi.mock("write-file-atomic", () => ({
  default: { sync: (...args: unknown[]) => writeFileSyncMock(...args) },
}));

const {
  addMedia,
  getRecentMedia,
  getMediaByType,
  formatMediaIndex,
  loadMediaIndex,
  flushMediaIndex,
} = await import("../storage/media-index.js");

describe("media-index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("[]");
    loadMediaIndex(); // reset state
  });

  it("adds and retrieves media", () => {
    const cid = `add-${Date.now()}`;
    addMedia({
      chatId: cid,
      msgId: 1,
      senderName: "Alice",
      type: "photo",
      filePath: "/tmp/photo.jpg",
      timestamp: Date.now(),
    });
    const media = getRecentMedia(cid);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe("photo");
    expect(media[0].filePath).toBe("/tmp/photo.jpg");
  });

  it("returns empty for unknown chat", () => {
    expect(getRecentMedia(`unknown-${Date.now()}`)).toHaveLength(0);
  });

  it("filters by type", () => {
    const cid = `type-${Date.now()}`;
    addMedia({
      chatId: cid,
      msgId: 1,
      senderName: "A",
      type: "photo",
      filePath: "/a.jpg",
      timestamp: Date.now(),
    });
    addMedia({
      chatId: cid,
      msgId: 2,
      senderName: "A",
      type: "document",
      filePath: "/b.pdf",
      timestamp: Date.now(),
    });
    addMedia({
      chatId: cid,
      msgId: 3,
      senderName: "A",
      type: "photo",
      filePath: "/c.jpg",
      timestamp: Date.now(),
    });

    expect(getMediaByType(cid, "photo")).toHaveLength(2);
    expect(getMediaByType(cid, "document")).toHaveLength(1);
  });

  it("deduplicates by chatId:msgId", () => {
    const chatId = `dedup-${Date.now()}`;
    addMedia({
      chatId,
      msgId: 1,
      senderName: "A",
      type: "photo",
      filePath: "/a.jpg",
      timestamp: 1000,
    });
    addMedia({
      chatId,
      msgId: 1,
      senderName: "A",
      type: "photo",
      filePath: "/b.jpg",
      timestamp: 2000,
    });

    const media = getRecentMedia(chatId);
    expect(media).toHaveLength(1);
    expect(media[0].filePath).toBe("/b.jpg");
  });

  it("formats index as text", () => {
    addMedia({
      chatId: "456",
      msgId: 10,
      senderName: "Bob",
      type: "photo",
      filePath: "/photo.jpg",
      caption: "sunset",
      timestamp: Date.now(),
    });
    const text = formatMediaIndex("456");
    expect(text).toContain("photo");
    expect(text).toContain("Bob");
    expect(text).toContain("/photo.jpg");
    expect(text).toContain("sunset");
  });

  it("returns 'no recent media' for empty chat", () => {
    expect(formatMediaIndex("empty")).toContain("No recent media");
  });

  it("limits results", () => {
    for (let i = 0; i < 15; i++) {
      addMedia({
        chatId: "789",
        msgId: i,
        senderName: "C",
        type: "photo",
        filePath: `/p${i}.jpg`,
        timestamp: Date.now() + i,
      });
    }
    expect(getRecentMedia("789", 5)).toHaveLength(5);
  });

  it("returns newest first", () => {
    addMedia({
      chatId: "100",
      msgId: 1,
      senderName: "A",
      type: "photo",
      filePath: "/old.jpg",
      timestamp: 1000,
    });
    addMedia({
      chatId: "100",
      msgId: 2,
      senderName: "A",
      type: "photo",
      filePath: "/new.jpg",
      timestamp: 2000,
    });

    const media = getRecentMedia("100");
    expect(media[0].filePath).toBe("/new.jpg");
  });

  describe("addMedia with all media types", () => {
    it("supports all media type variants", () => {
      const cid = `types-${Date.now()}`;
      const types = [
        "photo",
        "document",
        "voice",
        "video",
        "animation",
        "audio",
        "sticker",
      ] as const;
      types.forEach((type, i) => {
        addMedia({
          chatId: cid,
          msgId: i + 1,
          senderName: "User",
          type,
          filePath: `/tmp/${type}.bin`,
          timestamp: Date.now() + i,
        });
      });
      const media = getRecentMedia(cid, 20);
      expect(media).toHaveLength(7);
      const returnedTypes = media.map((m) => m.type).sort();
      expect(returnedTypes).toEqual([...types].sort());
    });

    it("supports caption field", () => {
      const cid = `cap-${Date.now()}`;
      addMedia({
        chatId: cid,
        msgId: 1,
        senderName: "User",
        type: "photo",
        filePath: "/a.jpg",
        caption: "My caption",
        timestamp: Date.now(),
      });
      const media = getRecentMedia(cid);
      expect(media[0].caption).toBe("My caption");
    });

    it("generates correct id from chatId:msgId", () => {
      const cid = `id-${Date.now()}`;
      addMedia({
        chatId: cid,
        msgId: 42,
        senderName: "User",
        type: "photo",
        filePath: "/a.jpg",
        timestamp: Date.now(),
      });
      const media = getRecentMedia(cid);
      expect(media[0].id).toBe(`${cid}:42`);
    });
  });

  describe("formatMediaIndex output format", () => {
    it("includes timestamp in readable format", () => {
      const ts = new Date("2025-03-15T14:30:00Z").getTime();
      addMedia({
        chatId: "fmt-1",
        msgId: 1,
        senderName: "Alice",
        type: "document",
        filePath: "/doc.pdf",
        timestamp: ts,
      });
      const text = formatMediaIndex("fmt-1");
      expect(text).toContain("2025-03-15 14:30");
      expect(text).toContain("[document]");
      expect(text).toContain("msg:1");
      expect(text).toContain("by Alice");
      expect(text).toContain("file: /doc.pdf");
    });

    it("truncates long captions at 50 characters", () => {
      const longCaption = "A".repeat(100);
      addMedia({
        chatId: "fmt-2",
        msgId: 1,
        senderName: "Bob",
        type: "photo",
        filePath: "/p.jpg",
        caption: longCaption,
        timestamp: Date.now(),
      });
      const text = formatMediaIndex("fmt-2");
      // Caption should be truncated to 50 chars
      expect(text).toContain(`"${"A".repeat(50)}"`);
      expect(text).not.toContain(`"${"A".repeat(51)}"`);
    });

    it("omits caption when not provided", () => {
      addMedia({
        chatId: "fmt-3",
        msgId: 1,
        senderName: "Bob",
        type: "photo",
        filePath: "/p.jpg",
        timestamp: Date.now(),
      });
      const text = formatMediaIndex("fmt-3");
      // Should not contain empty quotes
      expect(text).not.toContain('""');
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 20; i++) {
        addMedia({
          chatId: "fmt-4",
          msgId: i,
          senderName: "C",
          type: "photo",
          filePath: `/p${i}.jpg`,
          timestamp: Date.now() + i,
        });
      }
      const text = formatMediaIndex("fmt-4", 3);
      // Each entry has 2 lines (info + file path), so 3 entries
      const entryCount = (text.match(/\[photo\]/g) || []).length;
      expect(entryCount).toBe(3);
    });
  });

  describe("getMediaByType", () => {
    it("returns empty array when no entries match type", () => {
      const cid = `type-none-${Date.now()}`;
      addMedia({
        chatId: cid,
        msgId: 1,
        senderName: "A",
        type: "photo",
        filePath: "/a.jpg",
        timestamp: Date.now(),
      });
      expect(getMediaByType(cid, "voice")).toHaveLength(0);
    });

    it("respects limit parameter", () => {
      const cid = `type-limit-${Date.now()}`;
      for (let i = 0; i < 15; i++) {
        addMedia({
          chatId: cid,
          msgId: i,
          senderName: "A",
          type: "photo",
          filePath: `/p${i}.jpg`,
          timestamp: Date.now() + i,
        });
      }
      expect(getMediaByType(cid, "photo", 5)).toHaveLength(5);
    });

    it("returns newest first", () => {
      const cid = `type-order-${Date.now()}`;
      addMedia({
        chatId: cid,
        msgId: 1,
        senderName: "A",
        type: "voice",
        filePath: "/old.ogg",
        timestamp: 1000,
      });
      addMedia({
        chatId: cid,
        msgId: 2,
        senderName: "A",
        type: "voice",
        filePath: "/new.ogg",
        timestamp: 2000,
      });
      const result = getMediaByType(cid, "voice");
      expect(result[0].filePath).toBe("/new.ogg");
    });
  });

  describe("loadMediaIndex", () => {
    it("loads entries from existing file", () => {
      const stored = [
        {
          id: "load-1:1",
          chatId: "load-1",
          msgId: 1,
          senderName: "Alice",
          type: "photo",
          filePath: "/a.jpg",
          timestamp: Date.now(),
        },
        {
          id: "load-1:2",
          chatId: "load-1",
          msgId: 2,
          senderName: "Bob",
          type: "document",
          filePath: "/b.pdf",
          timestamp: Date.now(),
        },
      ];
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue(JSON.stringify(stored));

      loadMediaIndex();

      const media = getRecentMedia("load-1");
      expect(media).toHaveLength(2);
    });

    it("handles JSON parse errors gracefully", () => {
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue("not valid json{{{");

      // Should not throw, entries should be reset to []
      expect(() => loadMediaIndex()).not.toThrow();
    });

    it("purges expired entries on load", () => {
      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago (expired)
      const recentTimestamp = Date.now() - 1000; // 1 second ago (fresh)
      const stored = [
        {
          id: "purge:1",
          chatId: "purge",
          msgId: 1,
          senderName: "A",
          type: "photo",
          filePath: "/old.jpg",
          timestamp: oldTimestamp,
        },
        {
          id: "purge:2",
          chatId: "purge",
          msgId: 2,
          senderName: "A",
          type: "photo",
          filePath: "/new.jpg",
          timestamp: recentTimestamp,
        },
      ];
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue(JSON.stringify(stored));

      loadMediaIndex();

      const media = getRecentMedia("purge");
      expect(media).toHaveLength(1);
      expect(media[0].filePath).toBe("/new.jpg");
    });

    it("deletes expired media files from disk during purge", () => {
      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const stored = [
        {
          id: "del:1",
          chatId: "del",
          msgId: 1,
          senderName: "A",
          type: "photo",
          filePath: "/expired.jpg",
          timestamp: oldTimestamp,
        },
      ];
      // existsSync: first call for STORE_FILE=true, then for filePath during purge=true
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue(JSON.stringify(stored));

      loadMediaIndex();

      expect(unlinkSyncMock).toHaveBeenCalledWith("/expired.jpg");
    });
  });

  describe("flushMediaIndex", () => {
    it("writes entries to disk", () => {
      addMedia({
        chatId: "flush-1",
        msgId: 1,
        senderName: "A",
        type: "photo",
        filePath: "/a.jpg",
        timestamp: Date.now(),
      });

      existsSyncMock.mockReturnValue(true);
      flushMediaIndex();

      expect(writeFileSyncMock).toHaveBeenCalled();
      const writtenData = writeFileSyncMock.mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenData.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
    });

    it("creates workspace directory if it does not exist", () => {
      addMedia({
        chatId: "flush-2",
        msgId: 1,
        senderName: "A",
        type: "photo",
        filePath: "/a.jpg",
        timestamp: Date.now(),
      });

      existsSyncMock.mockReturnValue(false);
      flushMediaIndex();

      expect(mkdirSyncMock).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
      });
    });

    it("handles write errors gracefully", () => {
      addMedia({
        chatId: "flush-3",
        msgId: 1,
        senderName: "A",
        type: "photo",
        filePath: "/a.jpg",
        timestamp: Date.now(),
      });

      existsSyncMock.mockReturnValue(true);
      writeFileSyncMock.mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      expect(() => flushMediaIndex()).not.toThrow();
    });

    it("autoSave timer skips write when nothing has changed (dirty=false)", async () => {
      vi.useFakeTimers();
      existsSyncMock.mockReturnValue(true);
      // Don't add any media — dirty starts false after module load
      // Advance past the 30s autoSave interval to fire save() without dirty being set
      await vi.advanceTimersByTimeAsync(31_000);
      // save() should have been called by the interval but returned early (dirty=false)
      // The key assertion: no write was performed
      expect(writeFileSyncMock).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});

// ── save dirty=false early return ─────────────────────────────────────────

describe("media-index — save dirty=false early return (line 46 TRUE branch)", () => {
  it("does not write when auto-save fires with dirty=false", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const wfaMock = vi.fn();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => "[]"),
      unlinkSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: wfaMock } }));
    vi.doMock("../util/paths.js", () => ({
      files: { media: "/fake/media.json" },
      dirs: {},
    }));
    vi.doMock("../util/cleanup-registry.js", () => ({
      registerCleanup: vi.fn(),
    }));
    vi.doMock("../util/watchdog.js", () => ({ recordError: vi.fn() }));

    // Fresh import: dirty=false (nothing modified yet)
    await import("../storage/media-index.js");

    // Advance 31 seconds → auto-save timer fires → save() with dirty=false → early return
    await vi.advanceTimersByTimeAsync(31_000);
    expect(wfaMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
