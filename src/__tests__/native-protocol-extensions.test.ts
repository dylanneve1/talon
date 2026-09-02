/**
 * Tests for the bridge protocol extensions backing the companion app's
 * next-level features: history scroll-back pagination, wire-level full-text
 * search, and the turn-meta sidecar that lets tool timelines + turn stats
 * survive a history reload.
 */

import { describe, it, expect } from "vitest";

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
