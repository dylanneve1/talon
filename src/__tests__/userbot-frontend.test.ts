import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const sendUserbotMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue(42));
const sendUserbotTypingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const clearUserbotReactionsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const reactUserbotMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const disconnectUserClientMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const initUserClientMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const fetchSelfInfoMock = vi.hoisted(() => vi.fn());
const getSelfInfoMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({ id: 12345n, username: "testbot", firstName: "Test" }),
);
const getClientMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({
    addEventHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  }),
);
const setUserbotPrimaryMock = vi.hoisted(() => vi.fn());

vi.mock("../frontend/telegram/userbot.js", () => ({
  setUserbotPrimary: setUserbotPrimaryMock,
  initUserClient: initUserClientMock,
  fetchSelfInfo: fetchSelfInfoMock,
  getSelfInfo: getSelfInfoMock,
  getClient: getClientMock,
  sendUserbotMessage: sendUserbotMessageMock,
  sendUserbotTyping: sendUserbotTypingMock,
  clearUserbotReactions: clearUserbotReactionsMock,
  reactUserbotMessage: reactUserbotMessageMock,
  disconnectUserClient: disconnectUserClientMock,
}));

vi.mock("../frontend/telegram/userbot-actions.js", () => ({
  createUserbotActionHandler: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("../frontend/telegram/formatting.js", () => ({
  splitMessage: vi.fn((text: string) => [text]),
  escapeHtml: vi.fn((text: string) => text),
}));

vi.mock("../core/dispatcher.js", () => ({
  execute: vi.fn().mockResolvedValue({ bridgeMessageCount: 0, text: "" }),
}));

vi.mock("../core/prompt-builder.js", () => ({
  enrichDMPrompt: vi.fn((p: string) => p),
  enrichGroupPrompt: vi.fn((p: string) => p),
}));

vi.mock("../storage/daily-log.js", () => ({
  appendDailyLog: vi.fn(),
  appendDailyLogResponse: vi.fn(),
}));

vi.mock("../storage/history.js", () => ({
  pushMessage: vi.fn(),
  setMessageFilePath: vi.fn(),
  clearHistory: vi.fn(),
}));

vi.mock("../storage/media-index.js", () => ({
  addMedia: vi.fn(),
}));

vi.mock("../storage/sessions.js", () => ({
  resetSession: vi.fn(),
}));

vi.mock("../core/dream.js", () => ({
  forceDream: vi.fn(),
}));

vi.mock("../core/pulse.js", () => ({
  registerChat: vi.fn(),
}));

vi.mock("../core/errors.js", () => ({
  classify: vi.fn((e: unknown) => ({ reason: "error", message: String(e), retryable: false })),
  friendlyMessage: vi.fn(() => "An error occurred"),
}));

vi.mock("../util/watchdog.js", () => ({
  recordMessageProcessed: vi.fn(),
  recordError: vi.fn(),
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

// ── Dynamic import (after all vi.mock calls) ──────────────────────────────────

const {
  isRateLimited,
  shouldHandleInGroup,
  getSenderName,
  getSenderUsername,
  getSenderId,
  recordOurMessage,
  isOurMessage,
  clearRateLimits,
  clearOurMessageTracking,
  createUserbotFrontend,
} = await import("../frontend/telegram/userbot-frontend.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(overrides: Record<string, unknown> = {}): any {
  return { text: "", replyTo: undefined, ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("isRateLimited", () => {
  beforeEach(() => {
    clearRateLimits();
  });

  it("allows first message from a sender", () => {
    expect(isRateLimited(1001)).toBe(false);
  });

  it("allows up to 15 messages per minute", () => {
    for (let i = 0; i < 15; i++) {
      expect(isRateLimited(2001)).toBe(false);
    }
  });

  it("blocks the 16th message in the same minute", () => {
    for (let i = 0; i < 15; i++) {
      isRateLimited(3001);
    }
    expect(isRateLimited(3001)).toBe(true);
  });

  it("resets after the window passes", () => {
    const realNow = Date.now;
    const baseTime = Date.now();
    let fakeTime = baseTime;
    vi.spyOn(Date, "now").mockImplementation(() => fakeTime);

    for (let i = 0; i < 15; i++) {
      isRateLimited(4001);
    }
    expect(isRateLimited(4001)).toBe(true);

    // Advance time past the 60-second window
    fakeTime = baseTime + 61_000;
    expect(isRateLimited(4001)).toBe(false);

    vi.spyOn(Date, "now").mockImplementation(realNow);
  });

  it("tracks senders independently", () => {
    for (let i = 0; i < 15; i++) {
      isRateLimited(5001);
    }
    // Sender 5001 is limited; 5002 should not be
    expect(isRateLimited(5001)).toBe(true);
    expect(isRateLimited(5002)).toBe(false);
  });
});

describe("shouldHandleInGroup", () => {
  const selfId = 12345n;
  const selfUsername = "testbot";

  beforeEach(() => {
    clearOurMessageTracking();
  });

  it("returns true when @mentioned", () => {
    const msg = makeMsg({ text: "hey @testbot what's up" });
    expect(shouldHandleInGroup(msg, "chat1", selfUsername, selfId)).toBe(true);
  });

  it("returns true case-insensitively", () => {
    const msg = makeMsg({ text: "hey @TeStBoT!" });
    expect(shouldHandleInGroup(msg, "chat1", selfUsername, selfId)).toBe(true);
  });

  it("returns false for partial username match", () => {
    const msg = makeMsg({ text: "hey @testbotExtra" });
    expect(shouldHandleInGroup(msg, "chat1", selfUsername, selfId)).toBe(false);
  });

  it("returns false when no mention and no reply", () => {
    const msg = makeMsg({ text: "hello everyone" });
    expect(shouldHandleInGroup(msg, "chat1", selfUsername, selfId)).toBe(false);
  });

  it("returns true when replyTo is one of our messages", () => {
    recordOurMessage("chat1", 999);
    const msg = makeMsg({ replyTo: { replyToMsgId: 999 } });
    expect(shouldHandleInGroup(msg, "chat1", selfUsername, selfId)).toBe(true);
  });

  it("returns false when replyTo is not our message", () => {
    const msg = makeMsg({ replyTo: { replyToMsgId: 888 } });
    expect(shouldHandleInGroup(msg, "chat1", selfUsername, selfId)).toBe(false);
  });

  it("returns false when selfUsername is undefined", () => {
    const msg = makeMsg({ text: "hey @testbot" });
    expect(shouldHandleInGroup(msg, "chat1", undefined, selfId)).toBe(false);
  });
});

describe("getSenderName", () => {
  it("combines first and last name", () => {
    expect(getSenderName({ firstName: "John", lastName: "Doe" })).toBe("John Doe");
  });

  it("uses only first name when no last", () => {
    expect(getSenderName({ firstName: "Alice" })).toBe("Alice");
  });

  it("uses title for channels", () => {
    expect(getSenderName({ title: "My Channel" })).toBe("My Channel");
  });

  it("returns 'User' for null entity", () => {
    expect(getSenderName(null)).toBe("User");
  });

  it("returns 'User' for empty names", () => {
    expect(getSenderName({})).toBe("User");
  });
});

describe("getSenderUsername", () => {
  it("returns username from entity", () => {
    expect(getSenderUsername({ username: "alice" })).toBe("alice");
  });

  it("returns undefined for no username", () => {
    expect(getSenderUsername({ firstName: "Bob" })).toBeUndefined();
  });

  it("returns undefined for null entity", () => {
    expect(getSenderUsername(null)).toBeUndefined();
  });
});

describe("getSenderId", () => {
  it("converts BigInt id to number", () => {
    expect(getSenderId({ id: 99999n })).toBe(99999);
  });

  it("converts number id to number", () => {
    expect(getSenderId({ id: 12345 })).toBe(12345);
  });

  it("returns undefined for null entity", () => {
    expect(getSenderId(null)).toBeUndefined();
  });
});

describe("recordOurMessage and isOurMessage", () => {
  beforeEach(() => {
    clearOurMessageTracking();
  });

  it("records a message and finds it", () => {
    recordOurMessage("chat42", 101);
    expect(isOurMessage("chat42", 101)).toBe(true);
  });

  it("returns false for unrecorded message", () => {
    expect(isOurMessage("chat42", 9999)).toBe(false);
  });

  it("records in different chats independently", () => {
    recordOurMessage("chatA", 1);
    recordOurMessage("chatB", 2);
    expect(isOurMessage("chatA", 1)).toBe(true);
    expect(isOurMessage("chatB", 2)).toBe(true);
    expect(isOurMessage("chatA", 2)).toBe(false);
    expect(isOurMessage("chatB", 1)).toBe(false);
  });

  it("evicts old messages at cap (500)", () => {
    const chatId = "chatCap";
    // Fill exactly to cap
    for (let i = 1; i <= 500; i++) {
      recordOurMessage(chatId, i);
    }
    // All 500 should be present
    expect(isOurMessage(chatId, 1)).toBe(true);
    expect(isOurMessage(chatId, 500)).toBe(true);

    // Adding 501 should evict the 50 oldest (1–50)
    recordOurMessage(chatId, 501);
    // The first message (1) should have been evicted
    expect(isOurMessage(chatId, 1)).toBe(false);
    // A recent message should still be present
    expect(isOurMessage(chatId, 501)).toBe(true);
  });
});

describe("clearRateLimits", () => {
  beforeEach(() => {
    clearRateLimits();
  });

  it("clears a specific sender", () => {
    // Fill up sender 7001
    for (let i = 0; i < 15; i++) isRateLimited(7001);
    expect(isRateLimited(7001)).toBe(true);

    clearRateLimits(7001);
    expect(isRateLimited(7001)).toBe(false);
  });

  it("clears all senders when no arg", () => {
    for (let i = 0; i < 15; i++) isRateLimited(8001);
    for (let i = 0; i < 15; i++) isRateLimited(8002);
    expect(isRateLimited(8001)).toBe(true);
    expect(isRateLimited(8002)).toBe(true);

    clearRateLimits();
    expect(isRateLimited(8001)).toBe(false);
    expect(isRateLimited(8002)).toBe(false);
  });
});

describe("createUserbotFrontend — shape", () => {
  const mockGateway: any = {
    setFrontendHandler: vi.fn(),
    start: vi.fn().mockResolvedValue(19876),
    setContext: vi.fn(),
    clearContext: vi.fn(),
    getMessageCount: vi.fn().mockReturnValue(0),
    getPort: vi.fn().mockReturnValue(19876),
    incrementMessages: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };

  const minimalConfig: any = {
    apiId: 123,
    apiHash: "hash",
    workspace: "/tmp/test-workspace",
    systemPrompt: "",
    adminUserId: 999,
    model: "claude-sonnet-4-6",
  };

  it("returns object with required TelegramFrontend interface methods", () => {
    const frontend = createUserbotFrontend(minimalConfig, mockGateway);
    expect(typeof frontend.init).toBe("function");
    expect(typeof frontend.start).toBe("function");
    expect(typeof frontend.stop).toBe("function");
    expect(typeof frontend.sendTyping).toBe("function");
    expect(typeof frontend.sendMessage).toBe("function");
    expect(typeof frontend.getBridgePort).toBe("function");
    expect(frontend.context).toBeDefined();
    expect(typeof frontend.context.acquire).toBe("function");
    expect(typeof frontend.context.release).toBe("function");
    expect(typeof frontend.context.getMessageCount).toBe("function");
  });

  it("context.acquire calls gateway.setContext", () => {
    const frontend = createUserbotFrontend(minimalConfig, mockGateway);
    frontend.context.acquire(42);
    expect(mockGateway.setContext).toHaveBeenCalledWith(42);
  });

  it("context.release calls gateway.clearContext", () => {
    const frontend = createUserbotFrontend(minimalConfig, mockGateway);
    frontend.context.release(42);
    expect(mockGateway.clearContext).toHaveBeenCalledWith(42);
  });
});
