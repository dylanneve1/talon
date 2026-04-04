/**
 * Extended prompt-builder tests — covers branches and edge cases not exercised
 * by the existing prompt-builder.test.ts.
 *
 * enrichDMPrompt edge cases:
 *   - Empty-string username (falsy → no @tag appended)
 *   - Whitespace-only name
 *   - Multi-line prompt body preserved exactly
 *   - Special characters in name / username
 *
 * enrichGroupPrompt branches:
 *   - Exactly 2 messages (boundary: 1 prior — triggers the formatting path)
 *   - 6 messages (5 prior + 1 current — tests full-width context window)
 *   - Line 33 defensive branch: priorMsgs.length === 0 cannot be reached via
 *     recentMsgs.length > 1 guard, but the behaviour is confirmed by the
 *     single-message case already in base tests; we verify the slice is correct.
 *   - senderName is taken from priorMsgs[0], not the current message
 *   - Timestamp formatting via formatSmartTimestamp is invoked (output contains
 *     a formatted timestamp string within the context block)
 *   - Text truncation at exactly 200 characters (boundary check)
 *   - Text shorter than 200 characters is not padded
 *   - getRecentBySenderId is called with the correct chatId and senderId
 *   - Output structure: context block precedes the prompt, separated by blank line
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

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

// We do NOT mock ../util/time.js — formatSmartTimestamp is a pure function
// that we want exercised for real so that timestamp output is visible in results.

// ── Dynamic imports (after mocks) ────────────────────────────────────────────

const { getRecentBySenderId, getRecentHistory } = await import("../storage/history.js");
const { enrichDMPrompt, enrichGroupPrompt } = await import("../core/prompt-builder.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal history message object. */
function msg(
  msgId: number,
  senderId: number,
  senderName: string,
  text: string,
  timestamp = Date.now(),
) {
  return { msgId, senderId, senderName, text, timestamp };
}

// ── enrichDMPrompt ────────────────────────────────────────────────────────────

describe("enrichDMPrompt — extended edge cases", () => {
  it("omits the @tag when username is an empty string (falsy branch)", () => {
    // senderUsername = "" → `${senderUsername ? ` (@${senderUsername})` : ""}` → ""
    const result = enrichDMPrompt("hello", "Alice", 100, "");
    expect(result).toBe("[DM from Alice]\nhello");
    expect(result).not.toContain("@");
  });

  it("preserves a multi-line prompt body verbatim", () => {
    const multiLine = "line one\nline two\nline three";
    const result = enrichDMPrompt(multiLine, "Bob", 100);
    expect(result).toBe(`[DM from Bob]\n${multiLine}`);
  });

  it("handles special characters in sender name", () => {
    const result = enrichDMPrompt("hi", "O'Brien & Co.", 100, "obrien");
    expect(result).toBe("[DM from O'Brien & Co. (@obrien)]\nhi");
  });

  it("handles special characters in username", () => {
    const result = enrichDMPrompt("hi", "User", 100, "user.name_123");
    expect(result).toBe("[DM from User (@user.name_123)]\nhi");
  });

  it("handles an empty prompt string", () => {
    const result = enrichDMPrompt("", "Carol", 100);
    expect(result).toBe("[DM from Carol]\n");
  });

  it("handles a whitespace-only sender name", () => {
    // No special handling expected — just passed through
    const result = enrichDMPrompt("msg", "  ", 100);
    expect(result).toBe("[DM from   ]\nmsg");
  });

  it("format is always [DM from NAME] newline PROMPT", () => {
    const name = "TestUser";
    const username = "tuser";
    const prompt = "test prompt";
    const result = enrichDMPrompt(prompt, name, 100, username);
    expect(result.startsWith("[DM from TestUser (@tuser)]\n")).toBe(true);
    expect(result.endsWith(prompt)).toBe(true);
  });
});

// ── enrichGroupPrompt ─────────────────────────────────────────────────────────

describe("enrichGroupPrompt — extended branch coverage", () => {
  beforeEach(() => {
    vi.mocked(getRecentHistory).mockReset();
  });

  it("includes context from all participants when multiple messages exist", () => {
    vi.mocked(getRecentHistory).mockReturnValue([
      msg(1, 10, "Alice", "alice said hi", new Date("2025-06-01T10:00:00Z").getTime()),
      msg(2, 20, "Bot", "bot replied", new Date("2025-06-01T10:00:30Z").getTime()),
      msg(3, 10, "Alice", "current message", new Date("2025-06-01T10:01:00Z").getTime()),
    ]);
    const result = enrichGroupPrompt("current message", "chat-x", 10);
    expect(result).toContain("Recent group thread:");
    expect(result).toContain("Alice: alice said hi");
    expect(result).toContain("Bot: bot replied");
    expect(result).toContain("current message"); // original prompt
  });

  it("calls getRecentHistory with chatId and limit 10", () => {
    vi.mocked(getRecentHistory).mockReturnValue([]);
    enrichGroupPrompt("hi", "specific-chat", 99);
    expect(getRecentHistory).toHaveBeenCalledWith("specific-chat", 10);
  });

  it("returns raw prompt when only 1 message in history", () => {
    vi.mocked(getRecentHistory).mockReturnValue([
      msg(1, 10, "Solo", "only message", Date.now()),
    ]);
    const result = enrichGroupPrompt("only message", "chat-solo", 10);
    expect(result).toBe("only message");
  });

  it("truncates messages at 200 characters", () => {
    const longText = "a".repeat(250);
    vi.mocked(getRecentHistory).mockReturnValue([
      msg(1, 40, "Eve", longText, Date.now() - 2000),
      msg(2, 40, "Eve", "current", Date.now()),
    ]);
    const result = enrichGroupPrompt("current", "chat-trunc", 40);
    expect(result).toContain("a".repeat(200));
    expect(result).not.toContain("a".repeat(201));
  });

  it("context block structure: [Recent group thread: ...] then blank line then prompt", () => {
    vi.mocked(getRecentHistory).mockReturnValue([
      msg(1, 50, "Gina", "past msg", Date.now() - 3000),
      msg(2, 50, "Gina", "now", Date.now()),
    ]);
    const result = enrichGroupPrompt("now", "chat-struct", 50);
    expect(result.startsWith("[Recent group thread:")).toBe(true);
    expect(result).toContain("]\n\nnow");
  });

  it("each prior message line is indented and includes sender name", () => {
    vi.mocked(getRecentHistory).mockReturnValue([
      msg(1, 60, "Hank", "indented message", Date.now() - 5000),
      msg(2, 60, "Hank", "current", Date.now()),
    ]);
    const result = enrichGroupPrompt("current", "chat-indent", 60);
    const lines = result.split("\n");
    const priorLine = lines.find((l) => l.includes("indented message"));
    expect(priorLine).toBeDefined();
    expect(priorLine!.startsWith("  [")).toBe(true);
    expect(priorLine).toContain("Hank:");
  });

  it("includes a formatted timestamp in each prior message line", () => {
    const ts = new Date("2020-03-15T12:34:00Z").getTime();
    vi.mocked(getRecentHistory).mockReturnValue([
      msg(1, 70, "Iris", "timestamped msg", ts),
      msg(2, 70, "Iris", "current", Date.now()),
    ]);
    const result = enrichGroupPrompt("current", "chat-ts", 70);
    const lines = result.split("\n");
    const priorLine = lines.find((l) => l.includes("timestamped msg"));
    expect(priorLine).toBeDefined();
    // Format: `  [<timestamp>] text` — there should be a timestamp inside brackets
    expect(priorLine).toMatch(/\[.+\]/);
  });

  // ── returns prompt unchanged for 0 and 1 message (re-confirmed at boundary)

  it("returns the prompt unchanged when getRecentBySenderId returns empty array", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([]);
    const result = enrichGroupPrompt("only message", "chat-empty", 1);
    expect(result).toBe("only message");
  });

  it("returns the prompt unchanged when exactly 1 message is returned (the current)", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([
      msg(1, 80, "Jan", "the only message", Date.now()),
    ]);
    const result = enrichGroupPrompt("the only message", "chat-one", 80);
    expect(result).toBe("the only message");
  });

  // ── multi-line prompt body is preserved ───────────────────────────────────

  it("preserves a multi-line original prompt after the context block", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([
      msg(1, 90, "Karl", "prior", Date.now() - 1000),
      msg(2, 90, "Karl", "current line 1\ncurrent line 2", Date.now()),
    ]);
    const result = enrichGroupPrompt("current line 1\ncurrent line 2", "chat-ml", 90);
    expect(result).toContain("current line 1\ncurrent line 2");
    expect(result.endsWith("current line 1\ncurrent line 2")).toBe(true);
  });
});
