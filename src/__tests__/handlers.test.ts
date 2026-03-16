import { describe, it, expect, vi } from "vitest";

vi.mock("../../core/dispatcher.js", () => ({
  execute: vi.fn(),
}));
vi.mock("../../core/prompt-builder.js", () => ({
  enrichDMPrompt: vi.fn((p: string) => p),
  enrichGroupPrompt: vi.fn((p: string) => p),
}));
vi.mock("../../storage/daily-log.js", () => ({
  appendDailyLog: vi.fn(),
}));
vi.mock("../../util/watchdog.js", () => ({
  recordMessageProcessed: vi.fn(),
  recordError: vi.fn(),
}));
vi.mock("../../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../../core/errors.js", () => ({
  classify: vi.fn((e: unknown) => e),
  friendlyMessage: vi.fn(() => "error"),
}));

const { shouldHandleInGroup, getSenderName, getReplyContext, getForwardContext } = await import(
  "../frontend/telegram/handlers.js"
);

describe("shouldHandleInGroup", () => {
  const makeCtx = (overrides: {
    type?: string;
    text?: string;
    username?: string;
    replyFromId?: number;
    botId?: number;
  } = {}) => ({
    chat: { type: overrides.type ?? "supergroup" },
    me: { id: overrides.botId ?? 999, username: overrides.username ?? "testbot" },
    message: {
      text: overrides.text ?? "",
      caption: undefined,
      reply_to_message: overrides.replyFromId
        ? { from: { id: overrides.replyFromId } }
        : undefined,
    },
  });

  // Cast partial objects to any — we only test the mention/reply logic, not the full Context
  const ctx = (overrides: Parameters<typeof makeCtx>[0] = {}) =>
    makeCtx(overrides) as any;

  it("returns true for DMs (not a group)", () => {
    expect(shouldHandleInGroup({ ...ctx(), chat: { type: "private" } })).toBe(true);
  });

  it("returns true when bot is mentioned with @", () => {
    expect(shouldHandleInGroup(ctx({ text: "hey @testbot what's up" }))).toBe(true);
  });

  it("returns true when bot is mentioned case-insensitively", () => {
    expect(shouldHandleInGroup(ctx({ text: "Hey @TestBot!" }))).toBe(true);
  });

  it("returns false when a different bot is mentioned", () => {
    expect(shouldHandleInGroup(ctx({ text: "hey @testbot123 what's up" }))).toBe(false);
  });

  it("returns false when bot name appears without @", () => {
    expect(shouldHandleInGroup(ctx({ text: "testbot is cool" }))).toBe(false);
  });

  it("returns true when replying to the bot", () => {
    expect(shouldHandleInGroup(ctx({ replyFromId: 999, botId: 999 }))).toBe(true);
  });

  it("returns false when replying to someone else", () => {
    expect(shouldHandleInGroup(ctx({ replyFromId: 123, botId: 999 }))).toBe(false);
  });

  it("returns false for plain group message without mention or reply", () => {
    expect(shouldHandleInGroup(ctx({ text: "hello everyone" }))).toBe(false);
  });

  it("handles @mention at end of message", () => {
    expect(shouldHandleInGroup(ctx({ text: "what do you think @testbot" }))).toBe(true);
  });

  it("handles @mention with punctuation after", () => {
    expect(shouldHandleInGroup(ctx({ text: "@testbot, help me" }))).toBe(true);
  });
});

describe("getSenderName", () => {
  it("returns first + last name", () => {
    expect(getSenderName({ first_name: "John", last_name: "Doe" })).toBe("John Doe");
  });

  it("returns first name only when no last name", () => {
    expect(getSenderName({ first_name: "Alice" })).toBe("Alice");
  });

  it("returns 'User' when undefined", () => {
    expect(getSenderName(undefined)).toBe("User");
  });

  it("returns 'User' when empty names", () => {
    expect(getSenderName({})).toBe("User");
  });
});

describe("getReplyContext", () => {
  it("returns empty for no reply", () => {
    expect(getReplyContext(undefined, 999)).toBe("");
  });

  it("returns empty when replying to bot itself", () => {
    expect(getReplyContext({ from: { id: 999 }, text: "hi" }, 999)).toBe("");
  });

  it("includes author and text for reply to others", () => {
    const result = getReplyContext(
      { from: { id: 123, first_name: "Alice" }, text: "original message" },
      999,
    );
    expect(result).toContain("Alice");
    expect(result).toContain("original message");
    expect(result).toContain("Replying to");
  });

  it("truncates long reply text to 500 chars", () => {
    const longText = "x".repeat(600);
    const result = getReplyContext(
      { from: { id: 123, first_name: "Bob" }, text: longText },
      999,
    );
    expect(result.length).toBeLessThan(600);
  });
});

describe("getForwardContext", () => {
  it("returns empty for non-forwarded messages", () => {
    expect(getForwardContext({})).toBe("");
  });

  it("handles forwarded from user", () => {
    const result = getForwardContext({
      forward_origin: {
        type: "user",
        sender_user: { first_name: "Charlie", last_name: "D" },
      },
    });
    expect(result).toContain("Charlie D");
    expect(result).toContain("Forwarded");
  });

  it("handles forwarded from channel", () => {
    const result = getForwardContext({
      forward_origin: { type: "channel", chat: { title: "News" } },
    });
    expect(result).toContain("News");
  });

  it("handles hidden user", () => {
    const result = getForwardContext({
      forward_origin: { type: "hidden_user", sender_user_name: "anon" },
    });
    expect(result).toContain("anon");
  });
});

describe("URL detection regex", () => {
  const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

  it("matches http URLs", () => {
    expect("check http://example.com".match(URL_REGEX)).toEqual(["http://example.com"]);
  });

  it("matches https URLs", () => {
    expect("visit https://example.com/page".match(URL_REGEX)).toEqual(["https://example.com/page"]);
  });

  it("matches multiple URLs", () => {
    const text = "see https://a.com and https://b.com/path";
    expect(text.match(URL_REGEX)).toEqual(["https://a.com", "https://b.com/path"]);
  });

  it("returns null for no URLs", () => {
    expect("hello world".match(URL_REGEX)).toBeNull();
  });

  it("handles URLs with query strings", () => {
    expect("https://example.com/search?q=test&page=1".match(URL_REGEX)).toEqual(
      ["https://example.com/search?q=test&page=1"],
    );
  });

  it("stops at whitespace", () => {
    expect("https://example.com rest of text".match(URL_REGEX)).toEqual(
      ["https://example.com"],
    );
  });

  it("stops at closing brackets", () => {
    expect("(https://example.com)".match(URL_REGEX)).toEqual(
      ["https://example.com"],
    );
  });
});
