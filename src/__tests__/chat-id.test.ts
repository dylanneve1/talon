import { describe, it, expect } from "vitest";

import {
  deriveNumericChatId,
  generateTerminalChatId,
  isTerminalChatId,
} from "../util/chat-id.js";

describe("deriveNumericChatId", () => {
  it("returns a positive number", () => {
    const id = deriveNumericChatId("test-chat");
    expect(id).toBeGreaterThan(0);
    expect(Number.isInteger(id)).toBe(true);
  });

  it("returns the same value for the same input", () => {
    const a = deriveNumericChatId("stable-id");
    const b = deriveNumericChatId("stable-id");
    expect(a).toBe(b);
  });

  it("returns different values for different inputs", () => {
    const a = deriveNumericChatId("chat-alpha");
    const b = deriveNumericChatId("chat-beta");
    expect(a).not.toBe(b);
  });

  it("handles terminal-style IDs", () => {
    const id = deriveNumericChatId("t_1711360000000");
    expect(id).toBeGreaterThan(0);
  });

  it("handles empty string", () => {
    const id = deriveNumericChatId("");
    expect(id).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(id)).toBe(true);
  });
});

describe("generateTerminalChatId", () => {
  it("returns a string starting with t_", () => {
    const id = generateTerminalChatId();
    expect(id).toMatch(/^t_\d+$/);
  });

  it("returns a string with numeric timestamp portion", () => {
    const id = generateTerminalChatId();
    const ts = Number(id.slice(2));
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThan(0);
  });

  it("uses a recent timestamp", () => {
    const before = Date.now();
    const id = generateTerminalChatId();
    const after = Date.now();
    const ts = Number(id.slice(2));
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("isTerminalChatId", () => {
  it('returns true for "1" (legacy ID)', () => {
    expect(isTerminalChatId("1")).toBe(true);
  });

  it("returns true for t_ prefixed IDs", () => {
    expect(isTerminalChatId("t_1711360000000")).toBe(true);
    expect(isTerminalChatId("t_0")).toBe(true);
    expect(isTerminalChatId("t_abc")).toBe(true);
  });

  it("returns false for Telegram numeric IDs", () => {
    expect(isTerminalChatId("123456789")).toBe(false);
    expect(isTerminalChatId("-100123456")).toBe(false);
  });

  it("returns false for Teams IDs", () => {
    expect(isTerminalChatId("teams_chat_abc123")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isTerminalChatId("")).toBe(false);
  });

  it('returns false for "10" and other strings starting with 1', () => {
    expect(isTerminalChatId("10")).toBe(false);
    expect(isTerminalChatId("100")).toBe(false);
  });
});
