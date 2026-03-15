import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the log module
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// Mock the actions module
vi.mock("../bridge/actions.js", () => ({
  handleAction: vi.fn(async (body: { action: string }) => ({
    ok: true,
    action: body.action,
  })),
}));

// Mock formatting
vi.mock("../telegram/formatting.js", () => ({
  markdownToTelegramHtml: vi.fn((s: string) => s),
}));

const {
  withRetry,
  replyParams,
  sendText,
  startBridge,
  stopBridge,
  getBridgePort,
  setBridgeBotToken,
  getBotToken,
  incrementBridgeMessageCount,
  getBridgeMessageCount,
  setBridgeContext,
  clearBridgeContext,
  getScheduledMessages,
  TELEGRAM_MAX_TEXT,
} = await import("../bridge/server.js");

/** Minimal fake Bot object. */
function fakeBot(overrides: Record<string, unknown> = {}): any {
  return {
    api: {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
      ...overrides,
    },
  };
}

/** Minimal fake InputFile class. */
function fakeInputFile(): any {
  return class {};
}

describe("bridge/server", () => {
  beforeEach(() => {
    // Clear bridge context between tests
    for (let i = 0; i < 10; i++) {
      clearBridgeContext();
    }
  });

  describe("withRetry", () => {
    it("returns result on first success", async () => {
      const result = await withRetry(async () => "ok");
      expect(result).toBe("ok");
    });

    it("retries on transient error and succeeds", async () => {
      let attempt = 0;
      const result = await withRetry(async () => {
        attempt++;
        if (attempt < 2) throw new Error("500 Server Error");
        return "recovered";
      });
      expect(result).toBe("recovered");
      expect(attempt).toBe(2);
    });

    it("does not retry on 400 error", async () => {
      let attempt = 0;
      await expect(
        withRetry(async () => {
          attempt++;
          throw new Error("400 Bad Request");
        }),
      ).rejects.toThrow("400 Bad Request");
      expect(attempt).toBe(1);
    });

    it("does not retry on 403 error", async () => {
      let attempt = 0;
      await expect(
        withRetry(async () => {
          attempt++;
          throw new Error("403 Forbidden");
        }),
      ).rejects.toThrow("403 Forbidden");
      expect(attempt).toBe(1);
    });

    it("throws after 3 failed attempts", async () => {
      let attempt = 0;
      await expect(
        withRetry(async () => {
          attempt++;
          throw new Error("502 Bad Gateway");
        }),
      ).rejects.toThrow("502 Bad Gateway");
      expect(attempt).toBe(3);
    });
  });

  describe("replyParams", () => {
    it("returns message_id object when reply_to is a positive number", () => {
      const result = replyParams({ action: "send", reply_to: 42 });
      expect(result).toEqual({ message_id: 42 });
    });

    it("returns message_id object when reply_to_message_id is a positive number", () => {
      const result = replyParams({
        action: "send",
        reply_to_message_id: 99,
      });
      expect(result).toEqual({ message_id: 99 });
    });

    it("returns undefined when reply_to is 0", () => {
      const result = replyParams({ action: "send", reply_to: 0 });
      expect(result).toBeUndefined();
    });

    it("returns undefined when reply_to is negative", () => {
      const result = replyParams({ action: "send", reply_to: -1 });
      expect(result).toBeUndefined();
    });

    it("returns undefined when no reply field present", () => {
      const result = replyParams({ action: "send" });
      expect(result).toBeUndefined();
    });

    it("returns undefined when reply_to is a string", () => {
      const result = replyParams({ action: "send", reply_to: "abc" });
      expect(result).toBeUndefined();
    });
  });

  describe("sendText", () => {
    it("sends message via bot API and returns message_id", async () => {
      const bot = fakeBot();
      const msgId = await sendText(bot, 12345, "Hello!");
      expect(msgId).toBe(1);
      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        12345,
        "Hello!",
        expect.objectContaining({ parse_mode: "HTML" }),
      );
    });

    it("includes reply_parameters when replyTo is provided", async () => {
      const bot = fakeBot();
      await sendText(bot, 12345, "Reply", 42);
      expect(bot.api.sendMessage).toHaveBeenCalledWith(
        12345,
        expect.any(String),
        expect.objectContaining({
          reply_parameters: { message_id: 42 },
        }),
      );
    });

    it("throws when message exceeds TELEGRAM_MAX_TEXT", async () => {
      const bot = fakeBot();
      const longText = "x".repeat(TELEGRAM_MAX_TEXT + 1);
      await expect(sendText(bot, 12345, longText)).rejects.toThrow(
        "Message too long",
      );
    });

    it("falls back to plain text when HTML parse fails", async () => {
      const bot = fakeBot({
        sendMessage: vi
          .fn()
          .mockRejectedValueOnce(new Error("parse error"))
          .mockResolvedValueOnce({ message_id: 2 }),
      });
      const msgId = await sendText(bot, 12345, "**bold**");
      expect(msgId).toBe(2);
      // Should have been called twice (HTML attempt + fallback)
      expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe("setBridgeBotToken / getBotToken", () => {
    it("stores and retrieves bot token", () => {
      setBridgeBotToken("test-bot-token-123");
      expect(getBotToken()).toBe("test-bot-token-123");
    });
  });

  describe("incrementBridgeMessageCount", () => {
    it("increments the message counter", () => {
      setBridgeContext(9999, fakeBot(), fakeInputFile());
      const before = getBridgeMessageCount();
      incrementBridgeMessageCount();
      incrementBridgeMessageCount();
      expect(getBridgeMessageCount()).toBe(before + 2);
    });
  });

  describe("getScheduledMessages", () => {
    it("returns a Map", () => {
      const map = getScheduledMessages();
      expect(map).toBeInstanceOf(Map);
    });
  });

  describe("TELEGRAM_MAX_TEXT", () => {
    it("is 4096", () => {
      expect(TELEGRAM_MAX_TEXT).toBe(4096);
    });
  });

  describe("startBridge / stopBridge", () => {
    afterEach(async () => {
      await stopBridge();
    });

    it("starts and stops the HTTP server", async () => {
      const port = await startBridge(19900);
      expect(port).toBeGreaterThanOrEqual(19900);
      expect(getBridgePort()).toBe(port);

      await stopBridge();
      expect(getBridgePort()).toBe(0);
    });

    it("returns existing port if already started", async () => {
      const port1 = await startBridge(19901);
      const port2 = await startBridge(19901);
      expect(port1).toBe(port2);
    });

    it("stopBridge is safe to call when not started", async () => {
      await expect(stopBridge()).resolves.toBeUndefined();
    });

    it("responds to POST /action", async () => {
      const port = await startBridge(19902);
      const resp = await fetch(`http://127.0.0.1:${port}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test_action" }),
      });
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.ok).toBe(true);
    });

    it("returns 404 for non-POST or wrong path", async () => {
      const port = await startBridge(19903);
      const resp = await fetch(`http://127.0.0.1:${port}/other`);
      expect(resp.status).toBe(404);
    });

    it("returns 500 on handler error", async () => {
      const { handleAction } = await import("../bridge/actions.js");
      vi.mocked(handleAction).mockRejectedValueOnce(
        new Error("handler boom"),
      );

      const port = await startBridge(19904);
      const resp = await fetch(`http://127.0.0.1:${port}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "will_fail" }),
      });
      expect(resp.status).toBe(500);
      const data = await resp.json();
      expect(data.ok).toBe(false);
      expect(data.error).toContain("handler boom");
    });
  });
});
