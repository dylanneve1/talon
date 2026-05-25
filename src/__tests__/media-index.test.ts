/**
 * Media index tests — JsonStore-backed persistence.
 *
 * Uses a real temp directory rather than mocking `node:fs`. The
 * store path resolves against `process.env.HOME`, which we override
 * per-test for isolation. Matches the pattern used by
 * `codex-oauth-incompat.test.ts` after Phase 6.x #1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let tempHome: string;

function storePath(): string {
  return resolve(tempHome, ".talon", "data", "media-index.json");
}

function seedStore(entries: unknown): void {
  const p = storePath();
  mkdirSync(dirname(p), { recursive: true });
  // Mirror the legacy bare-array on-disk shape so the migrate hook
  // exercises pre-envelope behaviour.
  writeFileSync(p, JSON.stringify(entries));
}

async function freshImport() {
  // Re-import storage modules per test so the module-scoped
  // JsonStore picks up the temp HOME.
  vi.resetModules();
  return await import("../storage/media-index.js");
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tempHome = mkdtempSync(join(tmpdir(), "talon-media-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile;
  } else {
    delete process.env.USERPROFILE;
  }
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("media-index", () => {
  it("adds and retrieves media", async () => {
    const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
    loadMediaIndex();
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

  it("returns empty for unknown chat", async () => {
    const { getRecentMedia, loadMediaIndex } = await freshImport();
    loadMediaIndex();
    expect(getRecentMedia(`unknown-${Date.now()}`)).toHaveLength(0);
  });

  it("filters by type", async () => {
    const { addMedia, getMediaByType, loadMediaIndex } = await freshImport();
    loadMediaIndex();
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

  it("deduplicates by chatId:msgId", async () => {
    const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
    loadMediaIndex();
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

  it("formats index as text", async () => {
    const { addMedia, formatMediaIndex, loadMediaIndex } = await freshImport();
    loadMediaIndex();
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

  it("returns 'no recent media' for empty chat", async () => {
    const { formatMediaIndex, loadMediaIndex } = await freshImport();
    loadMediaIndex();
    expect(formatMediaIndex("empty")).toContain("No recent media");
  });

  it("limits results", async () => {
    const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
    loadMediaIndex();
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

  it("returns newest first", async () => {
    const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
    loadMediaIndex();
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
    it("supports all media type variants", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
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

    it("supports caption field", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
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

    it("generates correct id from chatId:msgId", async () => {
      const { addMedia, getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
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
    it("includes timestamp in readable format", async () => {
      const { addMedia, formatMediaIndex, loadMediaIndex } =
        await freshImport();
      loadMediaIndex();
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

    it("truncates long captions at 50 characters", async () => {
      const { addMedia, formatMediaIndex, loadMediaIndex } =
        await freshImport();
      loadMediaIndex();
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
      expect(text).toContain(`"${"A".repeat(50)}"`);
      expect(text).not.toContain(`"${"A".repeat(51)}"`);
    });

    it("omits caption when not provided", async () => {
      const { addMedia, formatMediaIndex, loadMediaIndex } =
        await freshImport();
      loadMediaIndex();
      addMedia({
        chatId: "fmt-3",
        msgId: 1,
        senderName: "Bob",
        type: "photo",
        filePath: "/p.jpg",
        timestamp: Date.now(),
      });
      const text = formatMediaIndex("fmt-3");
      expect(text).not.toContain('""');
    });

    it("respects limit parameter", async () => {
      const { addMedia, formatMediaIndex, loadMediaIndex } =
        await freshImport();
      loadMediaIndex();
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
      const entryCount = (text.match(/\[photo\]/g) || []).length;
      expect(entryCount).toBe(3);
    });
  });

  describe("getMediaByType", () => {
    it("returns empty array when no entries match type", async () => {
      const { addMedia, getMediaByType, loadMediaIndex } = await freshImport();
      loadMediaIndex();
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

    it("respects limit parameter", async () => {
      const { addMedia, getMediaByType, loadMediaIndex } = await freshImport();
      loadMediaIndex();
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

    it("returns newest first", async () => {
      const { addMedia, getMediaByType, loadMediaIndex } = await freshImport();
      loadMediaIndex();
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
    it("loads entries from existing legacy bare-array file", async () => {
      const now = Date.now();
      seedStore([
        {
          id: "load-1:1",
          chatId: "load-1",
          msgId: 1,
          senderName: "Alice",
          type: "photo",
          filePath: "/a.jpg",
          timestamp: now,
        },
        {
          id: "load-1:2",
          chatId: "load-1",
          msgId: 2,
          senderName: "Bob",
          type: "document",
          filePath: "/b.pdf",
          timestamp: now,
        },
      ]);
      const { getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const media = getRecentMedia("load-1");
      expect(media).toHaveLength(2);
    });

    it("loads entries from JsonStore envelope file", async () => {
      const now = Date.now();
      const p = storePath();
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(
        p,
        JSON.stringify({
          schemaVersion: 1,
          savedAt: now,
          data: [
            {
              id: "env:1",
              chatId: "env",
              msgId: 1,
              senderName: "Alice",
              type: "photo",
              filePath: "/x.jpg",
              timestamp: now,
            },
          ],
        }),
      );
      const { getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      expect(getRecentMedia("env")).toHaveLength(1);
    });

    it("handles JSON parse errors gracefully", async () => {
      const p = storePath();
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "not valid json{{{");
      const { loadMediaIndex } = await freshImport();
      expect(() => loadMediaIndex()).not.toThrow();
    });

    it("purges expired entries on load", async () => {
      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const recentTimestamp = Date.now() - 1000;
      seedStore([
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
      ]);
      const { getRecentMedia, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      const media = getRecentMedia("purge");
      expect(media).toHaveLength(1);
      expect(media[0].filePath).toBe("/new.jpg");
    });

    it("deletes expired media files from disk during purge", async () => {
      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const targetFile = join(tempHome, "expired.jpg");
      writeFileSync(targetFile, "stale");
      seedStore([
        {
          id: "del:1",
          chatId: "del",
          msgId: 1,
          senderName: "A",
          type: "photo",
          filePath: targetFile,
          timestamp: oldTimestamp,
        },
      ]);
      const { loadMediaIndex } = await freshImport();
      loadMediaIndex();
      expect(existsSync(targetFile)).toBe(false);
    });
  });

  describe("flushMediaIndex", () => {
    it("writes entries to disk in the envelope format", async () => {
      const { addMedia, flushMediaIndex, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      addMedia({
        chatId: "flush-1",
        msgId: 1,
        senderName: "A",
        type: "photo",
        filePath: "/a.jpg",
        timestamp: Date.now(),
      });
      flushMediaIndex();
      const persisted = JSON.parse(readFileSync(storePath(), "utf-8"));
      expect(persisted.schemaVersion).toBe(1);
      expect(Array.isArray(persisted.data)).toBe(true);
      expect(persisted.data.length).toBeGreaterThan(0);
      expect(persisted.data[0].chatId).toBe("flush-1");
    });

    it("creates data directory if it does not exist", async () => {
      const { addMedia, flushMediaIndex, loadMediaIndex } = await freshImport();
      loadMediaIndex();
      addMedia({
        chatId: "flush-2",
        msgId: 1,
        senderName: "A",
        type: "photo",
        filePath: "/a.jpg",
        timestamp: Date.now(),
      });
      // Remove the dir so flush has to recreate it.
      rmSync(dirname(storePath()), { recursive: true, force: true });
      flushMediaIndex();
      expect(existsSync(storePath())).toBe(true);
    });
  });
});
