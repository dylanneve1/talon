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

const { getRecentBySenderId } = await import("../storage/history.js");
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
    vi.mocked(getRecentBySenderId).mockReset();
  });

  // ── boundary: exactly 2 messages (1 prior + 1 current) ──────────────────

  it("includes context when there are exactly 2 messages (minimum enrichment case)", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([
      msg(1, 10, "Alice", "prior message", new Date("2025-06-01T10:00:00Z").getTime()),
      msg(2, 10, "Alice", "current message", new Date("2025-06-01T10:01:00Z").getTime()),
    ]);
    const result = enrichGroupPrompt("current message", "chat-x", 10);
    expect(result).toContain("Alice's recent messages in this group:");
    expect(result).toContain("prior message");
    expect(result).toContain("current message"); // original prompt preserved
    // Structure: context block then blank line then prompt
    expect(result).toMatch(/\]\n\ncurrent message$/);
  });

  // ── senderName from priorMsgs[0], not the current message ───────────────

  it("uses the senderName from the first prior message (priorMsgs[0])", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([
      msg(1, 20, "FirstSender", "msg a", Date.now() - 5000),
      msg(2, 20, "SecondSender", "msg b", Date.now() - 3000), // prior[1]
      msg(3, 20, "ThirdSender", "current msg", Date.now()),   // current (slice off)
    ]);
    const result = enrichGroupPrompt("current msg", "chat-y", 20);
    // senderName header should be from index 0 of priorMsgs
    expect(result).toContain("FirstSender's recent messages in this group:");
  });

  // ── 6 messages: 5 prior + 1 current ─────────────────────────────────────

  it("includes all 5 prior messages when 6 total are returned", () => {
    const now = Date.now();
    vi.mocked(getRecentBySenderId).mockReturnValue([
      msg(1, 30, "Dave", "msg 1", now - 50000),
      msg(2, 30, "Dave", "msg 2", now - 40000),
      msg(3, 30, "Dave", "msg 3", now - 30000),
      msg(4, 30, "Dave", "msg 4", now - 20000),
      msg(5, 30, "Dave", "msg 5", now - 10000),
      msg(6, 30, "Dave", "current", now),
    ]);
    const result = enrichGroupPrompt("current", "chat-z", 30);
    expect(result).toContain("Dave's recent messages in this group:");
    for (let i = 1; i <= 5; i++) {
      expect(result).toContain(`msg ${i}`);
    }
    expect(result).toContain("current"); // original prompt
    // The current message's text should NOT appear inside the context block
    const contextBlock = result.split("]\n\n")[0];
    expect(contextBlock).not.toContain("current");
  });

  // ── text truncation at exactly 200 chars ─────────────────────────────────

  it("truncates messages at exactly 200 characters (slice boundary)", () => {
    const exactly200 = "a".repeat(200);
    const longText = "a".repeat(250);
    vi.mocked(getRecentBySenderId).mockReturnValue([
      msg(1, 40, "Eve", longText, Date.now() - 2000),
      msg(2, 40, "Eve", "current", Date.now()),
    ]);
    const result = enrichGroupPrompt("current", "chat-trunc", 40);
    expect(result).toContain(exactly200);
    expect(result).not.toContain("a".repeat(201));
  });

  it("short messages (< 200 chars) are not truncated or padded", () => {
    const shortText = "short message";
    vi.mocked(getRecentBySenderId).mockReturnValue([
      msg(1, 41, "Frank", shortText, Date.now() - 1000),
      msg(2, 41, "Frank", "current", Date.now()),
    ]);
    const result = enrichGroupPrompt("current", "chat-short", 41);
    expect(result).toContain(shortText);
    // The full text appears — no additional characters appended to the message body.
    // Note: the outer context bracket `]` is appended after the last context line
    // in the format `[header:\n  lines]`, so we check containment, not endsWith.
    const lines = result.split("\n");
    const priorLine = lines.find((l) => l.includes(shortText));
    expect(priorLine).toBeDefined();
    // Line format: `  [timestamp] short message` optionally followed by `]` (closing bracket)
    // Verify the message text appears after the timestamp bracket and is not padded
    expect(priorLine).toMatch(new RegExp(`\\] ${shortText}\\]?$`));
  });

  // ── getRecentBySenderId called with correct args ──────────────────────────

  it("calls getRecentBySenderId with the provided chatId and senderId", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([]);
    enrichGroupPrompt("hi", "specific-chat-id", 99);
    expect(getRecentBySenderId).toHaveBeenCalledWith("specific-chat-id", 99, 5);
  });

  it("requests exactly 5 recent messages from history", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([]);
    enrichGroupPrompt("hi", "chat-count", 55);
    const [, , limit] = vi.mocked(getRecentBySenderId).mock.calls[0];
    expect(limit).toBe(5);
  });

  // ── output structure ──────────────────────────────────────────────────────

  it("context block is wrapped with [ ... ] and separated from prompt by blank line", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([
      msg(1, 50, "Gina", "past msg", Date.now() - 3000),
      msg(2, 50, "Gina", "now", Date.now()),
    ]);
    const result = enrichGroupPrompt("now", "chat-struct", 50);
    // Should start with '[' (the context header)
    expect(result.startsWith("[")).toBe(true);
    // Blank line (\n\n) separates context block from the original prompt
    expect(result).toContain("]\n\nnow");
  });

  it("each prior message line is indented with two spaces", () => {
    vi.mocked(getRecentBySenderId).mockReturnValue([
      msg(1, 60, "Hank", "indented message", Date.now() - 5000),
      msg(2, 60, "Hank", "current", Date.now()),
    ]);
    const result = enrichGroupPrompt("current", "chat-indent", 60);
    // The format is `  [timestamp] message text`
    const lines = result.split("\n");
    const priorLine = lines.find((l) => l.includes("indented message"));
    expect(priorLine).toBeDefined();
    expect(priorLine!.startsWith("  [")).toBe(true);
  });

  // ── timestamp is formatted and embedded ──────────────────────────────────

  it("includes a formatted timestamp in each prior message line", () => {
    const ts = new Date("2020-03-15T12:34:00Z").getTime(); // past year → full date format
    vi.mocked(getRecentBySenderId).mockReturnValue([
      msg(1, 70, "Iris", "timestamped msg", ts),
      msg(2, 70, "Iris", "current", Date.now()),
    ]);
    const result = enrichGroupPrompt("current", "chat-ts", 70);
    // The context block line should contain a bracket-wrapped timestamp
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
