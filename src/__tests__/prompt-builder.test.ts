import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../storage/history.js", () => ({
  getRecentBySenderId: vi.fn(() => []),
}));

const { getRecentBySenderId } = await import("../storage/history.js");
const { enrichDMPrompt, enrichGroupPrompt } = await import(
  "../core/prompt-builder.js"
);

describe("enrichDMPrompt", () => {
  it("prepends DM metadata", () => {
    const result = enrichDMPrompt("hello", "Alice");
    expect(result).toBe("[DM from Alice]\nhello");
  });

  it("includes username when provided", () => {
    const result = enrichDMPrompt("hello", "Alice", "alice42");
    expect(result).toBe("[DM from Alice (@alice42)]\nhello");
  });

  it("works without username", () => {
    const result = enrichDMPrompt("hello", "Bob", undefined);
    expect(result).toBe("[DM from Bob]\nhello");
  });
});

describe("enrichGroupPrompt", () => {
  beforeEach(() => {
    vi.mocked(getRecentBySenderId).mockReset();
  });

  it("returns prompt unchanged when no prior messages", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([]);
    const result = enrichGroupPrompt("hello", "chat1", 42);
    expect(result).toBe("hello");
  });

  it("returns prompt unchanged when only one message (current)", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([
      { msgId: 1, senderId: 42, senderName: "Alice", text: "hello", timestamp: Date.now() },
    ]);
    const result = enrichGroupPrompt("hello", "chat1", 42);
    expect(result).toBe("hello");
  });

  it("prepends prior messages for threading context", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([
      { msgId: 1, senderId: 42, senderName: "Alice", text: "first message", timestamp: new Date("2025-01-01T10:00:00Z").getTime() },
      { msgId: 2, senderId: 42, senderName: "Alice", text: "second message", timestamp: new Date("2025-01-01T10:01:00Z").getTime() },
      { msgId: 3, senderId: 42, senderName: "Alice", text: "current", timestamp: new Date("2025-01-01T10:02:00Z").getTime() },
    ]);
    const result = enrichGroupPrompt("current", "chat1", 42);
    expect(result).toContain("Alice's recent messages");
    expect(result).toContain("first message");
    expect(result).toContain("second message");
    expect(result).toContain("current"); // the original prompt
  });

  it("truncates long messages to 200 chars", () => {
    const longText = "x".repeat(300);
    vi.mocked(getRecentBySenderId).mockReturnValue([
      { msgId: 1, senderId: 42, senderName: "Bob", text: longText, timestamp: Date.now() },
      { msgId: 2, senderId: 42, senderName: "Bob", text: "current", timestamp: Date.now() },
    ]);
    const result = enrichGroupPrompt("current", "chat1", 42);
    expect(result).not.toContain(longText); // full text shouldn't appear
    expect(result).toContain("x".repeat(200)); // truncated version should
  });
});
