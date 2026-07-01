/**
 * Tests for the bridge protocol extensions backing the companion app's
 * next-level features: history scroll-back pagination, wire-level full-text
 * search, and the turn-meta sidecar that lets tool timelines + turn stats
 * survive a history reload.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pushMessage,
  getRecentHistory,
  getHistoryBefore,
  searchHistoryMessages,
  type HistoryMessage,
} from "../storage/history.js";

function makeMsg(
  overrides: Partial<HistoryMessage> & { msgId: number },
): HistoryMessage {
  return {
    senderId: 1,
    senderName: "TestUser",
    text: `Message ${overrides.msgId}`,
    timestamp: overrides.msgId,
    ...overrides,
  };
}

describe("getHistoryBefore (scroll-back pagination)", () => {
  const chatId = () => `page-${Math.random().toString(36).slice(2)}`;

  it("returns the window strictly older than the anchor, chronological", () => {
    const id = chatId();
    for (let i = 1; i <= 30; i++) pushMessage(id, makeMsg({ msgId: i }));

    const newest = getRecentHistory(id, 10);
    expect(newest[0].msgId).toBe(21);

    const page = getHistoryBefore(id, 21, 10);
    expect(page).toHaveLength(10);
    expect(page[0].msgId).toBe(11);
    expect(page[9].msgId).toBe(20);
  });

  it("returns a short page at the top and empty past it", () => {
    const id = chatId();
    for (let i = 1; i <= 5; i++) pushMessage(id, makeMsg({ msgId: i }));

    expect(getHistoryBefore(id, 3, 10).map((m) => m.msgId)).toEqual([1, 2]);
    expect(getHistoryBefore(id, 1, 10)).toEqual([]);
  });

  it("is empty for an unknown chat", () => {
    expect(getHistoryBefore("nope", 100, 10)).toEqual([]);
  });
});

describe("searchHistoryMessages (wire-level FTS)", () => {
  const chatId = () => `search-${Math.random().toString(36).slice(2)}`;

  it("returns matching rows, not formatted text", () => {
    const id = chatId();
    pushMessage(id, makeMsg({ msgId: 1, text: "the quick brown fox" }));
    pushMessage(id, makeMsg({ msgId: 2, text: "lazy dog sleeps" }));
    pushMessage(id, makeMsg({ msgId: 3, text: "fox again, quicker" }));

    const hits = searchHistoryMessages(id, "fox");
    expect(hits.map((m) => m.msgId)).toEqual([1, 3]);
    expect(hits[0].text).toBe("the quick brown fox");
  });

  it("is empty on no match or empty query", () => {
    const id = chatId();
    pushMessage(id, makeMsg({ msgId: 1, text: "hello world" }));
    expect(searchHistoryMessages(id, "zebra")).toEqual([]);
    expect(searchHistoryMessages(id, "")).toEqual([]);
  });

  it("treats FTS operators as literals (no syntax injection)", () => {
    const id = chatId();
    pushMessage(id, makeMsg({ msgId: 1, text: "a AND b" }));
    expect(() => searchHistoryMessages(id, 'AND OR NEAR( " *')).not.toThrow();
  });
});

describe("turn-meta sidecar", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "talon-turnmeta-"));
    vi.resetModules();
    // turn-meta pulls in util/log.js, which reads files.log from paths at
    // import time — the mock must provide both surfaces.
    vi.doMock("../util/paths.js", () => ({
      dirs: { data: workDir, root: workDir },
      files: { log: join(workDir, "talon.log") },
    }));
  });

  afterEach(() => {
    vi.doUnmock("../util/paths.js");
    rmSync(workDir, { recursive: true, force: true });
  });

  async function loadModule() {
    return await import("../frontend/native/turn-meta.js");
  }

  it("records, reads back, and persists meta across a reload", async () => {
    const m1 = await loadModule();
    m1.recordTurnMeta("c1", "100", {
      durationMs: 4200,
      tokensIn: 10,
      tokensOut: 20,
      tools: [{ id: "t1", name: "search", durationMs: 800 }],
    });
    expect(m1.getTurnMeta("c1", "100")).toMatchObject({ durationMs: 4200 });
    m1.flushTurnMeta();

    const file = join(workDir, "native-turn-meta.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf-8")).c1["100"].tokensOut).toBe(
      20,
    );

    // Fresh module instance (daemon restart) reads the same sidecar.
    vi.resetModules();
    vi.doMock("../util/paths.js", () => ({
      dirs: { data: workDir, root: workDir },
      files: { log: join(workDir, "talon.log") },
    }));
    const m2 = await loadModule();
    expect(m2.getTurnMeta("c1", "100")?.tools?.[0].name).toBe("search");
  });

  it("merges repeated records for the same message", async () => {
    const m = await loadModule();
    m.recordTurnMeta("c1", "1", { durationMs: 100 });
    m.recordTurnMeta("c1", "1", { tokensIn: 5 });
    expect(m.getTurnMeta("c1", "1")).toMatchObject({
      durationMs: 100,
      tokensIn: 5,
    });
  });

  it("bounds the per-chat window and clears whole chats", async () => {
    const m = await loadModule();
    for (let i = 1; i <= 520; i++) {
      m.recordTurnMeta("c1", String(i), { durationMs: i });
    }
    // Oldest ids evicted past the 500 cap.
    expect(m.getTurnMeta("c1", "1")).toBeNull();
    expect(m.getTurnMeta("c1", "520")).not.toBeNull();

    m.clearTurnMeta("c1");
    expect(m.getTurnMeta("c1", "520")).toBeNull();
  });

  it("is null for unknown chat/message", async () => {
    const m = await loadModule();
    expect(m.getTurnMeta("nope", "1")).toBeNull();
  });
});
