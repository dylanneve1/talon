import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../storage/history.js", () => ({
  getRecentBySenderId: vi.fn(() => []),
  getRecentHistory: vi.fn(() => []),
}));
vi.mock("../storage/learning.js", () => ({
  getUserProfile: vi.fn(() => null),
}));
vi.mock("../storage/goals.js", () => ({
  getActiveGoals: vi.fn(() => []),
}));
vi.mock("../storage/relationships.js", () => ({
  getChatProfile: vi.fn(() => null),
}));

const { getRecentBySenderId, getRecentHistory } = await import("../storage/history.js");
const { enrichDMPrompt, enrichGroupPrompt } = await import(
  "../core/prompt-builder.js"
);

describe("enrichDMPrompt", () => {
  it("prepends DM metadata", () => {
    const result = enrichDMPrompt("hello", "Alice", 100);
    expect(result).toBe("[DM from Alice]\nhello");
  });

  it("includes username when provided", () => {
    const result = enrichDMPrompt("hello", "Alice", 100, "alice42");
    expect(result).toBe("[DM from Alice (@alice42)]\nhello");
  });

  it("works without username", () => {
    const result = enrichDMPrompt("hello", "Bob", 100, undefined);
    expect(result).toBe("[DM from Bob]\nhello");
  });
});

describe("enrichGroupPrompt", () => {
  beforeEach(() => {
    vi.mocked(getRecentHistory).mockReset();
  });

  it("returns prompt unchanged when no prior messages", () => {
    vi.mocked(getRecentHistory).mockReturnValue([]);
    const result = enrichGroupPrompt("hello", "chat1", 42);
    expect(result).toBe("hello");
  });

  it("returns prompt unchanged when only one message (current)", () => {
    vi.mocked(getRecentHistory).mockReturnValue([
      { msgId: 1, senderId: 42, senderName: "Alice", text: "hello", timestamp: Date.now() },
    ]);
    const result = enrichGroupPrompt("hello", "chat1", 42);
    expect(result).toBe("hello");
  });

  it("prepends recent thread from all participants", () => {
    vi.mocked(getRecentHistory).mockReturnValue([
      { msgId: 1, senderId: 42, senderName: "Alice", text: "first message", timestamp: new Date("2025-01-01T10:00:00Z").getTime() },
      { msgId: 2, senderId: 99, senderName: "Bot", text: "bot reply", timestamp: new Date("2025-01-01T10:00:30Z").getTime() },
      { msgId: 3, senderId: 42, senderName: "Alice", text: "current", timestamp: new Date("2025-01-01T10:01:00Z").getTime() },
    ]);
    const result = enrichGroupPrompt("current", "chat1", 42);
    expect(result).toContain("Recent group thread:");
    expect(result).toContain("Alice: first message");
    expect(result).toContain("Bot: bot reply");
    expect(result).toContain("current");
  });

  it("truncates long messages to 200 chars", () => {
    const longText = "x".repeat(300);
    vi.mocked(getRecentHistory).mockReturnValue([
      { msgId: 1, senderId: 42, senderName: "Bob", text: longText, timestamp: Date.now() },
      { msgId: 2, senderId: 42, senderName: "Bob", text: "current", timestamp: Date.now() },
    ]);
    const result = enrichGroupPrompt("current", "chat1", 42);
    expect(result).not.toContain(longText);
    expect(result).toContain("x".repeat(200));
  });
});
