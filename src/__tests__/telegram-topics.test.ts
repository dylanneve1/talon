import { describe, it, expect, beforeEach } from "vitest";
import {
  ambientThreadId,
  noteInboundThread,
  resolveThreadId,
  resetThreadRegistry,
} from "../frontend/telegram/topics.js";

beforeEach(() => resetThreadRegistry());

describe("thread registry", () => {
  it("tracks the last topic message per chat", () => {
    noteInboundThread(1, { is_topic_message: true, message_thread_id: 77 });
    noteInboundThread(2, { is_topic_message: true, message_thread_id: 9 });
    expect(ambientThreadId(1)).toBe(77);
    expect(ambientThreadId(2)).toBe(9);
  });

  it("clears the thread when conversation moves to General", () => {
    noteInboundThread(1, { is_topic_message: true, message_thread_id: 77 });
    noteInboundThread(1, {});
    expect(ambientThreadId(1)).toBeUndefined();
  });

  it("ignores reply-chain thread ids outside forum topics", () => {
    // Plain groups set message_thread_id on replies without is_topic_message.
    noteInboundThread(1, { message_thread_id: 41 });
    expect(ambientThreadId(1)).toBeUndefined();
  });
});

describe("resolveThreadId", () => {
  it("prefers an explicit thread_id over the ambient one", () => {
    noteInboundThread(1, { is_topic_message: true, message_thread_id: 77 });
    expect(resolveThreadId({ thread_id: 5 }, 1)).toBe(5);
    expect(resolveThreadId({ thread_id: "5" }, 1)).toBe(5);
  });

  it("falls back to the ambient thread", () => {
    noteInboundThread(1, { is_topic_message: true, message_thread_id: 77 });
    expect(resolveThreadId({}, 1)).toBe(77);
  });

  it('lets "general" (or 0) suppress the ambient thread', () => {
    noteInboundThread(1, { is_topic_message: true, message_thread_id: 77 });
    expect(resolveThreadId({ thread_id: "general" }, 1)).toBeUndefined();
    expect(resolveThreadId({ thread_id: 0 }, 1)).toBeUndefined();
  });

  it("returns undefined with no signal at all", () => {
    expect(resolveThreadId({}, 1)).toBeUndefined();
    expect(resolveThreadId({ thread_id: "bogus" }, 1)).toBeUndefined();
  });
});
