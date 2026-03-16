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

const { shouldHandleInGroup, getSenderName } = await import(
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
});
