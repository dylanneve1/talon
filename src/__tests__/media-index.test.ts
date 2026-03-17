import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "[]"),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

const { addMedia, getRecentMedia, getMediaByType, formatMediaIndex, loadMediaIndex } = await import("../storage/media-index.js");

describe("media-index", () => {
  beforeEach(() => {
    loadMediaIndex(); // reset state
  });

  it("adds and retrieves media", () => {
    const cid = `add-${Date.now()}`;
    addMedia({
      chatId: cid, msgId: 1, senderName: "Alice", type: "photo",
      filePath: "/tmp/photo.jpg", timestamp: Date.now(),
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
    addMedia({ chatId: cid, msgId: 1, senderName: "A", type: "photo", filePath: "/a.jpg", timestamp: Date.now() });
    addMedia({ chatId: cid, msgId: 2, senderName: "A", type: "document", filePath: "/b.pdf", timestamp: Date.now() });
    addMedia({ chatId: cid, msgId: 3, senderName: "A", type: "photo", filePath: "/c.jpg", timestamp: Date.now() });

    expect(getMediaByType(cid, "photo")).toHaveLength(2);
    expect(getMediaByType(cid, "document")).toHaveLength(1);
  });

  it("deduplicates by chatId:msgId", () => {
    const chatId = `dedup-${Date.now()}`;
    addMedia({ chatId, msgId: 1, senderName: "A", type: "photo", filePath: "/a.jpg", timestamp: 1000 });
    addMedia({ chatId, msgId: 1, senderName: "A", type: "photo", filePath: "/b.jpg", timestamp: 2000 });

    const media = getRecentMedia(chatId);
    expect(media).toHaveLength(1);
    expect(media[0].filePath).toBe("/b.jpg");
  });

  it("formats index as text", () => {
    addMedia({ chatId: "456", msgId: 10, senderName: "Bob", type: "photo", filePath: "/photo.jpg", caption: "sunset", timestamp: Date.now() });
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
      addMedia({ chatId: "789", msgId: i, senderName: "C", type: "photo", filePath: `/p${i}.jpg`, timestamp: Date.now() + i });
    }
    expect(getRecentMedia("789", 5)).toHaveLength(5);
  });

  it("returns newest first", () => {
    addMedia({ chatId: "100", msgId: 1, senderName: "A", type: "photo", filePath: "/old.jpg", timestamp: 1000 });
    addMedia({ chatId: "100", msgId: 2, senderName: "A", type: "photo", filePath: "/new.jpg", timestamp: 2000 });

    const media = getRecentMedia("100");
    expect(media[0].filePath).toBe("/new.jpg");
  });
});
