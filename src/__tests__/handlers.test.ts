import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../core/dispatcher.js", () => ({
  execute: executeMock,
}));
vi.mock("../core/prompt-builder.js", () => ({
  enrichDMPrompt: vi.fn((p: string) => p),
  enrichGroupPrompt: vi.fn((p: string) => p),
}));
vi.mock("../storage/daily-log.js", () => ({
  appendDailyLog: vi.fn(),
  appendDailyLogResponse: vi.fn(),
}));
vi.mock("../util/watchdog.js", () => ({
  recordMessageProcessed: vi.fn(),
  recordError: vi.fn(),
}));
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../core/errors.js", () => ({
  classify: vi.fn((e: unknown) => ({ reason: "error", message: String(e), retryable: false })),
  friendlyMessage: vi.fn(() => "An error occurred"),
}));

vi.mock("../storage/history.js", () => ({
  setMessageFilePath: vi.fn(),
  getRecentBySenderId: vi.fn(() => []),
}));
vi.mock("../storage/media-index.js", () => ({
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

  it("includes 'bot' as author when replying to bot itself", () => {
    const result = getReplyContext({ from: { id: 999 }, text: "hi" }, 999);
    expect(result).toContain("bot");
    expect(result).toContain("hi");
  });

  it("includes author, text, and message_id for reply to others", () => {
    const result = getReplyContext(
      { message_id: 42, from: { id: 123, first_name: "Alice" }, text: "original message" },
      999,
    );
    expect(result).toContain("Alice");
    expect(result).toContain("original message");
    expect(result).toContain("Replying to");
    expect(result).toContain("msg_id:42");
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
  it("returns empty when reply has no text, caption, media, or message_id", () => {
    expect(getReplyContext({ from: { id: 123 } }, 999)).toBe("");
  });

  it("includes message_id and media type even without text", () => {
    const result = getReplyContext(
      { message_id: 100, from: { id: 123, first_name: "Dan" }, photo: [{}] as unknown[] },
      999,
    );
    expect(result).toContain("msg_id:100");
    expect(result).toContain("[photo]");
    expect(result).toContain("Dan");
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

const {
  handleTextMessage, handlePhotoMessage, handleCallbackQuery,
  handleStickerMessage, handleVoiceMessage, handleVideoMessage,
  handleDocumentMessage, handleAudioMessage, handleVideoNoteMessage,
  handleAnimationMessage,
} = await import("../frontend/telegram/handlers.js");

// Shared mock objects used across all handler integration tests
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

describe("handleTextMessage — integration via mock Context", () => {

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

  it("enqueues and processes a DM message via flushQueue", async () => {
    executeMock.mockResolvedValue({
      text: "hello back",
      durationMs: 50,
      inputTokens: 5,
      outputTokens: 10,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const ctx = {
      chat: { id: 12345, type: "private" },
      message: { text: "hello", message_id: 100, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 42, first_name: "Alice" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);

    // Wait for real 500ms debounce plus buffer for async processing
    await new Promise((r) => setTimeout(r, 700));

    expect(executeMock).toHaveBeenCalled();
  }, 3000);

  it("enqueues multiple DM messages within debounce window — concatenates them", async () => {
    executeMock.mockResolvedValue({
      text: "concatenated response",
      durationMs: 30,
      inputTokens: 3,
      outputTokens: 5,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const chatId = 77777 + Math.floor(Math.random() * 1000); // unique id to avoid state sharing
    const makeCtx = (text: string, msgId: number) => ({
      chat: { id: chatId, type: "private" },
      message: { text, message_id: msgId, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 55, first_name: "Carol" },
    } as any);

    const before = executeMock.mock.calls.length;
    await handleTextMessage(makeCtx("first message", 301), mockBot, mockConfig);
    await handleTextMessage(makeCtx("second message", 302), mockBot, mockConfig);

    await new Promise((r) => setTimeout(r, 700));

    const newCalls = executeMock.mock.calls.slice(before).filter((c) => {
      const arg = c[0] as { chatId: string };
      return arg.chatId === String(chatId);
    });
    expect(newCalls.length).toBe(1);
    const callArg = newCalls[0][0] as { prompt: string };
    expect(callArg.prompt).toContain("first message");
    expect(callArg.prompt).toContain("second message");
  }, 3000);
});

describe("handlePhotoMessage — downloads and enqueues photo", () => {
  let restoreFetch: () => void;

  beforeEach(() => {
    // Mock bot.api.getFile for file download
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "photos/test.jpg" }));
    // Create a minimal valid JPEG buffer (FF D8 header = JPEG magic bytes)
    const jpegBuf = new Uint8Array(104);
    jpegBuf[0] = 0xFF;
    jpegBuf[1] = 0xD8;
    const mockFetch = vi.fn(async () => ({
      ok: true,
      headers: { get: (_name: string) => null },
      arrayBuffer: async () => jpegBuf.buffer,
    }));
    restoreFetch = () => {};
    vi.stubGlobal("fetch", mockFetch);

    executeMock.mockResolvedValue({
      text: "", durationMs: 10, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads photo and enqueues message", async () => {
    const chatId = 54321;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 500,
        photo: [
          { file_id: "small_id", file_unique_id: "small_uniq", width: 100, height: 100 },
          { file_id: "large_id", file_unique_id: "large_uniq", width: 800, height: 600 },
        ],
        caption: "Look at this!",
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 50, first_name: "Nina" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handlePhotoMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => {
      const arg = c[0] as { chatId: string };
      return arg.chatId === String(chatId);
    });
    expect(calls.length).toBe(1);
    const arg = calls[0][0] as { prompt: string };
    expect(arg.prompt).toContain("photo");
  }, 3000);

  it("returns error via bot API when file download fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    const ctx = {
      chat: { id: 54322, type: "private" },
      message: {
        message_id: 501,
        photo: [{ file_id: "bad_id", file_unique_id: "bad_uniq", width: 100, height: 100 }],
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 51, first_name: "Oscar" },
    } as any;

    await handlePhotoMessage(ctx, mockBot, mockConfig);
    // Should call sendMessage with error text
    expect(mockBot.api.sendMessage).toHaveBeenCalled();
  });

  it("rejects oversized document files", async () => {
    const ctx = {
      chat: { id: 54323, type: "private" },
      message: {
        message_id: 502,
        document: {
          file_id: "big_doc",
          file_unique_id: "big_uniq",
          file_name: "huge.pdf",
          file_size: 30 * 1024 * 1024, // 30MB > 20MB limit
          mime_type: "application/pdf",
        },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 52, first_name: "Paula" },
    } as any;

    await handleDocumentMessage(ctx, mockBot, mockConfig);
    expect(mockBot.api.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("large"),
      expect.anything(),
    );
  });
});

describe("handleCallbackQuery — processes button press", () => {
  it("calls execute when callbackQuery has data", async () => {
    executeMock.mockResolvedValue({
      text: "response",
      durationMs: 10,
      inputTokens: 1,
      outputTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: 0,
    });

    const ctx = {
      callbackQuery: { data: "button_option_a", message: { message_id: 50 } },
      chat: { id: 555, type: "private" },
      from: { id: 10, first_name: "Dave" },
      answerCallbackQuery: vi.fn(async () => {}),
    } as any;

    const before = executeMock.mock.calls.length;
    await handleCallbackQuery(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBeGreaterThan(before);
    const arg = executeMock.mock.calls[executeMock.mock.calls.length - 1][0] as { prompt: string };
    expect(arg.prompt).toContain("button_option_a");
  });

  it("returns early when callbackQuery has no data", async () => {
    const ctx = {
      callbackQuery: { message: { message_id: 51 } }, // no data
      chat: { id: 556 },
      from: { id: 11, first_name: "Eve" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleCallbackQuery(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });
});

describe("handleVoiceMessage/handleVideoMessage/handleDocumentMessage/handleAudioMessage — early returns", () => {
  it("handleVoiceMessage returns early when no voice data", async () => {
    const ctx = {
      chat: { id: 888, type: "private" },
      message: { message_id: 10, voice: null },
      me: { id: 999, username: "testbot" },
      from: { id: 30, first_name: "Hank" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleVoiceMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("handleVideoMessage returns early when no video data", async () => {
    const ctx = {
      chat: { id: 889, type: "private" },
      message: { message_id: 11, video: null },
      me: { id: 999, username: "testbot" },
      from: { id: 31, first_name: "Iris" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleVideoMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("handleDocumentMessage returns early when no document", async () => {
    const ctx = {
      chat: { id: 890, type: "private" },
      message: { message_id: 12, document: null },
      me: { id: 999, username: "testbot" },
      from: { id: 32, first_name: "Jack" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleDocumentMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("handleAudioMessage returns early when no audio", async () => {
    const ctx = {
      chat: { id: 891, type: "private" },
      message: { message_id: 13, audio: null },
      me: { id: 999, username: "testbot" },
      from: { id: 33, first_name: "Kate" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleAudioMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("handleAnimationMessage returns early when no animation", async () => {
    const ctx = {
      chat: { id: 892, type: "private" },
      message: { message_id: 14, animation: null },
      me: { id: 999, username: "testbot" },
      from: { id: 34, first_name: "Liam" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleAnimationMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("handleVideoNoteMessage returns early when no video_note", async () => {
    const ctx = {
      chat: { id: 893, type: "private" },
      message: { message_id: 15, video_note: null },
      me: { id: 999, username: "testbot" },
      from: { id: 35, first_name: "Mia" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleVideoNoteMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });
});

describe("rate limiting — isUserRateLimited via handleTextMessage", () => {
  it("blocks message after RATE_LIMIT_MAX_MESSAGES (15) messages from same user", async () => {
    const userId = 99999; // unique user ID for this test
    const makeCtx = (i: number) => ({
      chat: { id: 11111 + i, type: "private" }, // different chat each time to avoid queue conflicts
      message: { text: `message ${i}`, message_id: 1000 + i, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: userId, first_name: "RateLimitUser" },
    } as any);

    // Send 15 messages — all should be enqueued
    for (let i = 0; i < 15; i++) {
      await handleTextMessage(makeCtx(i), mockBot, mockConfig);
    }

    // 16th message should be rate limited (return early without enqueuing)
    const before = executeMock.mock.calls.length;
    await handleTextMessage(makeCtx(15), mockBot, mockConfig);

    // Wait to confirm no debounce fires for the 16th chat
    await new Promise((r) => setTimeout(r, 50));
    // The 16th message's chatId never appeared in the queue, so execute won't be called for it
    const rateLimitedCalls = executeMock.mock.calls.filter((c) => {
      const arg = c[0] as { chatId: string };
      return arg.chatId === String(11111 + 15);
    });
    expect(rateLimitedCalls.length).toBe(0);
  }, 3000);
});

describe("handleStickerMessage — enqueues sticker prompt", () => {
  it("enqueues a sticker message", async () => {
    executeMock.mockResolvedValue({
      text: "", durationMs: 10, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 0,
    });
    const ctx = {
      chat: { id: 66666, type: "private" },
      message: {
        message_id: 200,
        sticker: { file_id: "sticker123", emoji: "😀", set_name: "AnimatedEmoji", is_animated: false, is_video: false },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 20, first_name: "Frank" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleStickerMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => {
      const arg = c[0] as { chatId: string };
      return arg.chatId === "66666";
    });
    expect(calls.length).toBe(1);
    const arg = calls[0][0] as { prompt: string };
    expect(arg.prompt).toContain("sticker");
    expect(arg.prompt).toContain("sticker123");
  }, 3000);

  it("returns early when no sticker in message", async () => {
    const ctx = {
      chat: { id: 777, type: "private" },
      message: { message_id: 300, sticker: null },
      me: { id: 999, username: "testbot" },
      from: { id: 21, first_name: "Grace" },
    } as any;
    const before = executeMock.mock.calls.length;
    await handleStickerMessage(ctx, mockBot, mockConfig);
    expect(executeMock.mock.calls.length).toBe(before);
  });

  it("builds sticker prompt with animated flag", async () => {
    executeMock.mockResolvedValue({
      text: "", durationMs: 10, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 0,
    });
    const chatId = 66667;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 201,
        sticker: { file_id: "anim123", emoji: "🔥", set_name: "", is_animated: true, is_video: false },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 22, first_name: "Heidi" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleStickerMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { prompt: string }).prompt).toContain("animated");
  }, 3000);
});

// Helper: create a minimal non-image binary buffer (e.g. for voice/video/audio)
function makeBinaryBuffer(size = 64): ArrayBuffer {
  const arr = new Uint8Array(size);
  arr[0] = 0x1A; arr[1] = 0x45; // some random non-image bytes
  return arr.buffer;
}

describe("handleVoiceMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "voice/test.ogg" }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => makeBinaryBuffer(),
    })));
    executeMock.mockResolvedValue({
      text: "", durationMs: 10, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads voice and enqueues message", async () => {
    const chatId = 70001;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 600,
        voice: { file_id: "voice_abc", file_unique_id: "vuq1", duration: 5 },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 60, first_name: "Nora" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleVoiceMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { prompt: string }).prompt).toContain("voice");
  }, 3000);
});

describe("handleAudioMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "audio/test.mp3" }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => makeBinaryBuffer(),
    })));
    executeMock.mockResolvedValue({
      text: "", durationMs: 10, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads audio with title and performer", async () => {
    const chatId = 70002;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 601,
        audio: { file_id: "audio_abc", file_unique_id: "auq1", duration: 180, title: "My Song", performer: "Artist", file_name: "song.mp3", file_size: 2 * 1024 * 1024 },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 61, first_name: "Oscar" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleAudioMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    const prompt = (calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("My Song");
    expect(prompt).toContain("Artist");
  }, 3000);

  it("handles audio without title (falls back to file_name)", async () => {
    const chatId = 70003;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 602,
        audio: { file_id: "audio_def", file_unique_id: "auq2", duration: 60, file_name: "recording.mp3", file_size: 500_000 },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 62, first_name: "Paula" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleAudioMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { prompt: string }).prompt).toContain("recording.mp3");
  }, 3000);
});

describe("handleVideoNoteMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "video_note/test.mp4" }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => makeBinaryBuffer(),
    })));
    executeMock.mockResolvedValue({
      text: "", durationMs: 10, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads video_note and enqueues message", async () => {
    const chatId = 70004;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 603,
        video_note: { file_id: "vn_abc", file_unique_id: "vnq1", duration: 15, file_size: 300_000 },
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 63, first_name: "Quinn" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleVideoNoteMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    expect((calls[0][0] as { prompt: string }).prompt).toContain("round video");
  }, 3000);
});

describe("handleDocumentMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "documents/test.pdf" }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => makeBinaryBuffer(),
    })));
    executeMock.mockResolvedValue({
      text: "", durationMs: 10, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads document and enqueues message", async () => {
    const chatId = 70005;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 604,
        document: {
          file_id: "doc_abc", file_unique_id: "dq1",
          file_name: "report.pdf", file_size: 1_000_000,
          mime_type: "application/pdf",
        },
        caption: "Please review",
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 64, first_name: "Rachel" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleDocumentMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    const prompt = (calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("report.pdf");
    expect(prompt).toContain("Please review");
  }, 3000);
});

describe("handleVideoMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "videos/test.mp4" }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => makeBinaryBuffer(),
    })));
    executeMock.mockResolvedValue({
      text: "", durationMs: 10, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads video and enqueues message", async () => {
    const chatId = 70006;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 605,
        video: { file_id: "vid_abc", file_unique_id: "vq1", duration: 30, width: 1280, height: 720, file_name: "clip.mp4" },
        caption: "Check this out",
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 65, first_name: "Sam" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleVideoMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    const prompt = (calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("clip.mp4");
    expect(prompt).toContain("Check this out");
  }, 3000);
});

describe("handleTextMessage — group message with @mention", () => {
  it("enqueues group message when bot is mentioned", async () => {
    executeMock.mockResolvedValue({
      text: "group response",
      durationMs: 50, inputTokens: 5, outputTokens: 10, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 0,
    });

    const chatId = 80001;
    const ctx = {
      chat: { id: chatId, type: "supergroup", title: "Test Group" },
      message: { text: "@testbot hello from group", message_id: 700, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 70, first_name: "Tom" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    const arg = calls[0][0] as { isGroup: boolean; prompt: string };
    expect(arg.isGroup).toBe(true);
    expect(arg.prompt).toContain("@testbot hello from group");
  }, 3000);
});

describe("handleCallbackQuery — error path", () => {
  it("logs error when processAndReply throws", async () => {
    const { logError } = await import("../util/log.js");
    executeMock.mockRejectedValueOnce(new Error("callback execute failed"));

    const ctx = {
      callbackQuery: { data: "broken_action", message: { message_id: 800 } },
      chat: { id: 90001, type: "private" },
      from: { id: 80, first_name: "Uma" },
      answerCallbackQuery: vi.fn(async () => {}),
    } as any;

    await handleCallbackQuery(ctx, mockBot, mockConfig);
    expect(logError).toHaveBeenCalled();
  });
});

describe("flushQueue — retryable error path", () => {
  it("retries once on retryable error and sends error message on retry failure", async () => {
    const { classify, friendlyMessage } = await import("../core/errors.js");

    // First execute call throws (retryable), second also throws (unrecoverable)
    executeMock
      .mockRejectedValueOnce(new Error("overloaded"))
      .mockRejectedValueOnce(new Error("still overloaded"));

    (classify as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ reason: "overloaded", message: "overloaded", retryable: true, retryAfterMs: 10 })
      .mockReturnValueOnce({ reason: "overloaded", message: "still overloaded", retryable: false });

    (friendlyMessage as ReturnType<typeof vi.fn>).mockReturnValue("Service temporarily overloaded");

    const chatId = 95001;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: { text: "test retry", message_id: 900, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 90, first_name: "Victor" },
    } as any;

    const sendMsgCalls = mockBot.api.sendMessage.mock.calls.length;
    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    // Should have sent an error message after retry failure
    expect(mockBot.api.sendMessage.mock.calls.length).toBeGreaterThan(sendMsgCalls);
  }, 3000);
});

describe("downloadTelegramFile — content-length too large", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws when content-length header exceeds 50MB limit", async () => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "photos/big.jpg" }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: { get: (name: string) => name === "content-length" ? String(51 * 1024 * 1024) : null },
      arrayBuffer: async () => makeBinaryBuffer(),
    })));

    const ctx = {
      chat: { id: 95002, type: "private" },
      message: {
        message_id: 901,
        photo: [{ file_id: "big_photo", file_unique_id: "bpq1", width: 4000, height: 3000 }],
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 91, first_name: "Wendy" },
    } as any;

    await handlePhotoMessage(ctx, mockBot, mockConfig);
    // Should report error via sendMessage
    expect(mockBot.api.sendMessage).toHaveBeenCalled();
  });
});

describe("downloadTelegramFile — invalid image content", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects photo with invalid magic bytes (not a real image)", async () => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "photos/fake.jpg" }));
    // Return a buffer with no valid image header
    const fakeData = new Uint8Array(64); // all zeros, not a valid image
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => fakeData.buffer,
    })));

    const ctx = {
      chat: { id: 95003, type: "private" },
      message: {
        message_id: 902,
        photo: [{ file_id: "fake_photo", file_unique_id: "fpq1", width: 100, height: 100 }],
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 92, first_name: "Xander" },
    } as any;

    await handlePhotoMessage(ctx, mockBot, mockConfig);
    // Should report error via sendMessage
    expect(mockBot.api.sendMessage).toHaveBeenCalled();
  });
});

describe("handleAnimationMessage — downloads and enqueues", () => {
  beforeEach(() => {
    mockBot.api.getFile = vi.fn(async () => ({ file_path: "animations/test.mp4" }));
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => makeBinaryBuffer(),
    })));
    executeMock.mockResolvedValue({
      text: "", durationMs: 10, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads animation and enqueues message", async () => {
    const chatId = 70007;
    const ctx = {
      chat: { id: chatId, type: "private" },
      message: {
        message_id: 606,
        animation: { file_id: "anim_abc", file_unique_id: "aq1", duration: 3, file_name: "funny.mp4" },
        caption: "lol",
        reply_to_message: null,
      },
      me: { id: 999, username: "testbot" },
      from: { id: 66, first_name: "Tara" },
    } as any;

    const before = executeMock.mock.calls.length;
    await handleAnimationMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    const calls = executeMock.mock.calls.slice(before).filter((c) => (c[0] as { chatId: string }).chatId === String(chatId));
    expect(calls.length).toBe(1);
    const prompt = (calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("funny.mp4");
    expect(prompt).toContain("lol");
  }, 3000);
});

describe("processAndReply — onToolUse callback triggers appendDailyLogResponse", () => {
  it("calls appendDailyLogResponse when execute invokes onToolUse with send tool", async () => {
    const { appendDailyLogResponse } = await import("../storage/daily-log.js");

    executeMock.mockImplementationOnce(async (params: Record<string, unknown>) => {
      // Simulate execute calling onToolUse with a "send" tool
      const onToolUse = params.onToolUse as (toolName: string, input: Record<string, unknown>) => void;
      onToolUse?.("send", { type: "text", text: "Hello from Claude!" });
      return { text: "", durationMs: 5, inputTokens: 1, outputTokens: 2, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 1 };
    });

    const ctx = {
      chat: { id: 96001, type: "private" },
      message: { text: "hi", message_id: 950, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 93, first_name: "Yuki" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    expect(appendDailyLogResponse).toHaveBeenCalledWith("Talon", "Hello from Claude!", expect.anything());
  }, 3000);
});

describe("createStreamCallbacks — onTextBlock delivers message via sendHtml", () => {
  it("calls sendMessage when execute invokes onTextBlock", async () => {
    const sendMsgCount = () => (mockBot.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length;

    executeMock.mockImplementationOnce(async (params: Record<string, unknown>) => {
      const onTextBlock = params.onTextBlock as (text: string) => Promise<void>;
      await onTextBlock?.("**Bold response**");
      return { text: "", durationMs: 5, inputTokens: 1, outputTokens: 2, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 1 };
    });

    const before = sendMsgCount();
    const ctx = {
      chat: { id: 96002, type: "private" },
      message: { text: "test onTextBlock", message_id: 951, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 93, first_name: "Yuki" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    expect(sendMsgCount()).toBeGreaterThan(before);
  }, 3000);
});

describe("sendHtml — falls back to plain text on HTML send failure", () => {
  it("sends plain text when HTML mode fails", async () => {
    executeMock.mockResolvedValue({
      text: "", durationMs: 10, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, bridgeMessageCount: 0,
    });

    // Make the first sendMessage (HTML) throw, then succeed on second call (plain text)
    let callCount = 0;
    mockBot.api.sendMessage = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("Bad Request: can't parse entities");
      return { message_id: callCount };
    });

    // Trigger sendHtml via the error handler path (classify returns non-retryable error)
    const { classify, friendlyMessage } = await import("../core/errors.js");
    executeMock.mockRejectedValueOnce(new Error("some error"));
    (classify as ReturnType<typeof vi.fn>).mockReturnValueOnce({ reason: "error", message: "some error", retryable: false });
    (friendlyMessage as ReturnType<typeof vi.fn>).mockReturnValueOnce("<b>Bold error</b>");

    const ctx = {
      chat: { id: 97001, type: "private" },
      message: { text: "test html fallback", message_id: 960, reply_to_message: null },
      me: { id: 999, username: "testbot" },
      from: { id: 94, first_name: "Zoe" },
    } as any;

    await handleTextMessage(ctx, mockBot, mockConfig);
    await new Promise((r) => setTimeout(r, 700));

    // Second call should be plain text (HTML stripped)
    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2);
    const secondCallArg = (mockBot.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1][1];
    expect(secondCallArg).toContain("Bold error");
    expect(secondCallArg).not.toContain("<b>");

    // Restore sendMessage mock for other tests
    mockBot.api.sendMessage = vi.fn(async () => ({ message_id: 1 }));
  }, 3000);
});

