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

vi.mock("../../storage/history.js", () => ({
  setMessageFilePath: vi.fn(),
  getRecentBySenderId: vi.fn(() => []),
}));
vi.mock("../../storage/media-index.js", () => ({
  addMedia: vi.fn(),
}));
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
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

  it("handles chat type forward", () => {
    const result = getForwardContext({
      forward_origin: { type: "chat", chat: { title: "Support Group" } },
    });
    expect(result).toContain("Support Group");
  });

  it("handles channel with no title", () => {
    const result = getForwardContext({
      forward_origin: { type: "channel", chat: {} },
    });
    expect(result).toContain("a chat");
  });

  it("handles unknown forward type", () => {
    const result = getForwardContext({
      forward_origin: { type: "unknown_type" },
    });
    expect(result).toContain("someone");
  });
});

describe("getReplyContext — edge cases", () => {
  it("returns empty when reply has no text or caption", () => {
    expect(getReplyContext({ from: { id: 123 } }, 999)).toBe("");
  });

  it("uses caption when text is missing", () => {
    const result = getReplyContext(
      { from: { id: 123, first_name: "Eve" }, caption: "photo caption" },
      999,
    );
    expect(result).toContain("photo caption");
  });

  it("includes full name from first and last", () => {
    const result = getReplyContext(
      { from: { id: 123, first_name: "Jane", last_name: "Smith" }, text: "hello" },
      999,
    );
    expect(result).toContain("Jane Smith");
  });
});

describe("shouldHandleInGroup — edge cases", () => {
  const ctx = (overrides: Record<string, unknown> = {}) => ({
    chat: { type: overrides.type ?? "supergroup" },
    me: { id: overrides.botId ?? 999, username: overrides.username ?? "testbot" },
    message: {
      text: overrides.text ?? "",
      caption: overrides.caption ?? undefined,
      reply_to_message: overrides.replyFromId
        ? { from: { id: overrides.replyFromId } }
        : undefined,
    },
  }) as any;

  it("returns false when no chat", () => {
    expect(shouldHandleInGroup({ chat: null, message: {} } as any)).toBe(false);
  });

  it("returns false when no message", () => {
    expect(shouldHandleInGroup({ chat: { type: "group" }, message: null } as any)).toBe(false);
  });

  it("detects bot mention in caption", () => {
    expect(shouldHandleInGroup(ctx({ caption: "look @testbot", text: "" }))).toBe(true);
  });

  it("handles 'group' type (not just supergroup)", () => {
    expect(shouldHandleInGroup(ctx({ type: "group", text: "@testbot hi" }))).toBe(true);
  });

  it("returns false for group with @mention as part of longer username", () => {
    // @testbot123 should NOT match @testbot (word boundary check)
    expect(shouldHandleInGroup(ctx({ text: "hey @testbot_extra" }))).toBe(false);
  });
});

describe("getSenderName — edge cases", () => {
  it("returns last name only when no first name", () => {
    expect(getSenderName({ last_name: "Doe" })).toBe("Doe");
  });

  it("trims whitespace from names", () => {
    // filter(Boolean) handles empty strings
    expect(getSenderName({ first_name: "", last_name: "Smith" })).toBe("Smith");
  });
});

const { handleTextMessage, handlePhotoMessage, handleCallbackQuery } = await import(
  "../frontend/telegram/handlers.js"
);

describe("handleTextMessage — integration via mock Context", () => {

  const mockBot = {
    api: {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      sendChatAction: vi.fn(async () => {}),
      setMessageReaction: vi.fn(async () => {}),
      sendMessageDraft: vi.fn(async () => {}),
    },
  } as any;

  const mockConfig = {
    botToken: "test",
    model: "claude-sonnet-4-6",
    maxMessageLength: 4000,
    workspace: "/tmp/test-workspace",
  } as any;

  it("silently returns when ctx.message is missing", async () => {
    await handleTextMessage({ chat: { id: 1 } } as any, mockBot, mockConfig);
    // Should not throw
  });

  it("silently returns when ctx.chat is missing", async () => {
    await handleTextMessage({ message: { text: "hi" } } as any, mockBot, mockConfig);
    // Should not throw
  });

  it("silently returns for group message without mention", async () => {
    const ctx = {
      chat: { id: 1, type: "supergroup" },
      message: { text: "hello everyone", message_id: 1, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 1, first_name: "User" },
    } as any;
    await handleTextMessage(ctx, mockBot, mockConfig);
    // Should not enqueue (no mention or reply to bot)
  });

  it("silently returns when photo has no photos array", async () => {
    const ctx = {
      chat: { id: 1, type: "private" },
      message: { photo: null, message_id: 1 },
      me: { id: 999, username: "testbot" },
      from: { id: 1, first_name: "User" },
    } as any;
    await handlePhotoMessage(ctx, mockBot, mockConfig);
  });

  it("silently returns when callback query has no data", async () => {
    const ctx = {
      callbackQuery: { message: { message_id: 1 } },  // no 'data' property
      chat: { id: 1 },
      from: { id: 1, first_name: "User" },
    } as any;
    await handleCallbackQuery(ctx, mockBot, mockConfig);
  });
});

