import { describe, it, expect, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../frontend/telegram/userbot.js", () => ({
  initUserClient: vi.fn().mockResolvedValue(true),
  disconnectUserClient: vi.fn().mockResolvedValue(undefined),
  fetchSelfInfo: vi.fn(),
  getSelfInfo: vi.fn().mockReturnValue(null),
  isUserClientReady: vi.fn().mockReturnValue(false),
  setUserbotPrimary: vi.fn(),
  getClient: vi.fn().mockReturnValue(null),
  sendUserbotMessage: vi.fn().mockResolvedValue(0),
  sendUserbotTyping: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../frontend/telegram/userbot-frontend.js", () => ({
  createUserbotFrontend: vi.fn(),
}));

vi.mock("../frontend/telegram/userbot-actions.js", () => ({
  createUserbotActionHandler: vi.fn(),
}));

vi.mock("grammy", () => ({
  Bot: vi.fn().mockReturnValue({
    api: {
      config: { use: vi.fn() },
      deleteMyCommands: vi.fn().mockResolvedValue(undefined),
      setMyCommands: vi.fn().mockResolvedValue(undefined),
    },
  }),
  InputFile: vi.fn(),
}));

vi.mock("@grammyjs/auto-retry", () => ({
  autoRetry: vi.fn(),
}));

vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: vi.fn(),
}));

vi.mock("../frontend/telegram/actions.js", () => ({
  createTelegramActionHandler: vi.fn(),
  sendText: vi.fn(),
}));

vi.mock("../frontend/telegram/commands.js", () => ({
  registerCommands: vi.fn(),
  setAdminUserId: vi.fn(),
}));

vi.mock("../frontend/telegram/middleware.js", () => ({
  registerMiddleware: vi.fn(),
}));

vi.mock("../frontend/telegram/callbacks.js", () => ({
  registerCallbacks: vi.fn(),
}));

// ── Dynamic import (after all vi.mock calls) ──────────────────────────────────

const { isUserbotMode, isDualMode } = await import("../frontend/telegram/index.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function cfg(overrides: Record<string, unknown> = {}): any {
  return { model: "claude-sonnet-4-6", frontend: "telegram", ...overrides };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("isUserbotMode", () => {
  it("returns true with apiId + apiHash and no botToken", () => {
    expect(isUserbotMode(cfg({ apiId: 12345, apiHash: "abc123" }))).toBe(true);
  });

  it("returns false with botToken only", () => {
    expect(isUserbotMode(cfg({ botToken: "123:ABC" }))).toBe(false);
  });

  it("returns false with botToken AND apiId+apiHash (dual mode uses isDualMode instead)", () => {
    expect(isUserbotMode(cfg({ botToken: "123:ABC", apiId: 12345, apiHash: "abc123" }))).toBe(
      false,
    );
  });

  it("returns false with nothing set", () => {
    expect(isUserbotMode(cfg())).toBe(false);
  });

  it("returns false with only apiId (no apiHash)", () => {
    expect(isUserbotMode(cfg({ apiId: 12345 }))).toBe(false);
  });
});

describe("isDualMode", () => {
  it("returns true with botToken AND apiId+apiHash", () => {
    expect(isDualMode(cfg({ botToken: "123:ABC", apiId: 12345, apiHash: "abc123" }))).toBe(true);
  });

  it("returns false with only botToken", () => {
    expect(isDualMode(cfg({ botToken: "123:ABC" }))).toBe(false);
  });

  it("returns false with only apiId+apiHash (userbot-only)", () => {
    expect(isDualMode(cfg({ apiId: 12345, apiHash: "abc123" }))).toBe(false);
  });

  it("returns false with nothing", () => {
    expect(isDualMode(cfg())).toBe(false);
  });

  it("returns false with partial MTProto credentials (no apiHash)", () => {
    expect(isDualMode(cfg({ botToken: "123:ABC", apiId: 12345 }))).toBe(false);
  });
});
