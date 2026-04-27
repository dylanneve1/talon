import { beforeEach, describe, expect, it, vi } from "vitest";

const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: logWarnMock,
  logDebug: vi.fn(),
}));

vi.mock("../core/plugin.js", () => ({
  handlePluginAction: vi.fn(async () => null),
}));

vi.mock("../util/watchdog.js", () => ({
  recordError: vi.fn(),
  getHealthStatus: vi.fn(() => ({
    healthy: true,
    totalMessagesProcessed: 0,
    recentErrorCount: 0,
    msSinceLastMessage: 0,
  })),
}));

vi.mock("../storage/sessions.js", () => ({
  getActiveSessionCount: vi.fn(() => 0),
}));

vi.mock("../frontend/telegram/userbot.js", () => ({
  isUserClientReady: vi.fn(() => false),
  searchMessages: vi.fn(),
  getHistory: vi.fn(),
  getParticipantDetails: vi.fn(),
  getUserInfo: vi.fn(),
  getMessage: vi.fn(),
  getPinnedMessages: vi.fn(),
  getOnlineCount: vi.fn(),
  saveStickerPack: vi.fn(),
}));

const { Gateway } = await import("../core/gateway.js");
const { createTelegramActionHandler, sendText } =
  await import("../frontend/telegram/actions.js");

function createBot() {
  const api = {
    sendMessage: vi.fn(),
    setMessageReaction: vi.fn(),
  };
  return {
    api,
    bot: { api } as unknown as Parameters<typeof sendText>[0],
  };
}

function createHandler(
  bot: Parameters<typeof sendText>[0],
  gateway: InstanceType<typeof Gateway>,
) {
  class TestInputFile {}
  return createTelegramActionHandler(
    bot,
    TestInputFile as unknown as Parameters<
      typeof createTelegramActionHandler
    >[1],
    "123456:test-token",
    gateway,
  );
}

describe("telegram action handler", () => {
  beforeEach(() => {
    logWarnMock.mockClear();
  });

  it("sendText retries plain text when Telegram rejects HTML parsing", async () => {
    const { api, bot } = createBot();
    api.sendMessage
      .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
      .mockResolvedValueOnce({ message_id: 22 });

    await expect(sendText(bot, 99, "**hello**", 7)).resolves.toBe(22);

    expect(api.sendMessage).toHaveBeenNthCalledWith(1, 99, "<b>hello</b>", {
      parse_mode: "HTML",
      reply_parameters: { message_id: 7 },
    });
    expect(api.sendMessage).toHaveBeenNthCalledWith(2, 99, "**hello**", {
      reply_parameters: { message_id: 7 },
    });
    expect(logWarnMock).toHaveBeenCalledWith(
      "bot",
      expect.stringContaining("retrying without parse_mode"),
    );
  });

  it("records a bridge message only after send_message succeeds", async () => {
    const { api, bot } = createBot();
    api.sendMessage.mockResolvedValueOnce({ message_id: 101 });
    const gateway = new Gateway();
    gateway.setContext(42);
    const handler = createHandler(bot, gateway);

    await expect(
      handler({ action: "send_message", text: "**sent**" }, 42),
    ).resolves.toEqual({ ok: true, message_id: 101 });

    expect(gateway.getMessageCount(42)).toBe(1);
  });

  it("does not record a bridge message when Telegram rejects both formatted and plain sends", async () => {
    const { api, bot } = createBot();
    api.sendMessage.mockRejectedValue(
      new Error("400 Bad Request: chat not found"),
    );
    const gateway = new Gateway();
    gateway.setContext(42);
    const handler = createHandler(bot, gateway);

    await expect(
      handler({ action: "send_message", text: "**lost**" }, 42),
    ).rejects.toThrow("chat not found");

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(gateway.getMessageCount(42)).toBe(0);
  });

  it("falls back to a thumbs-up reaction and records success once fallback succeeds", async () => {
    const { api, bot } = createBot();
    api.setMessageReaction
      .mockRejectedValueOnce(new Error("400 Bad Request: invalid reaction"))
      .mockResolvedValueOnce(undefined);
    const gateway = new Gateway();
    gateway.setContext(42);
    const handler = createHandler(bot, gateway);

    await expect(
      handler({ action: "react", message_id: 5, emoji: "🧪" }, 42),
    ).resolves.toEqual({ ok: true });

    expect(api.setMessageReaction).toHaveBeenNthCalledWith(1, 42, 5, [
      { type: "emoji", emoji: "🧪" },
    ]);
    expect(api.setMessageReaction).toHaveBeenNthCalledWith(2, 42, 5, [
      { type: "emoji", emoji: "👍" },
    ]);
    expect(gateway.getMessageCount(42)).toBe(1);
    expect(logWarnMock).toHaveBeenCalledWith(
      "bot",
      expect.stringContaining("falling back to"),
    );
  });
});
