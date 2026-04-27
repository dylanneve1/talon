import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../frontend/teams/proxy-fetch.js", () => ({
  proxyFetch: proxyFetchMock,
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/plugin.js", () => ({
  handlePluginAction: vi.fn(async () => null),
}));

vi.mock("../core/dispatcher.js", () => ({
  getActiveCount: vi.fn(() => 0),
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

const { Gateway } = await import("../core/gateway.js");
const { createTeamsActionHandler } =
  await import("../frontend/teams/actions.js");
const { logError } = await import("../util/log.js");

describe("teams action handler", () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
    vi.mocked(logError).mockClear();
  });

  it("splits long send_message payloads into real Adaptive Card webhook posts and records one logical message", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    });
    const gateway = new Gateway();
    gateway.setContext(123);
    const handler = createTeamsActionHandler(
      "https://webhook.example.com",
      gateway,
    );
    const paragraphs = Array.from(
      { length: 3 },
      (_, i) => `paragraph-${i} ` + "x".repeat(9_500),
    ).join("\n\n");

    const result = await handler(
      { action: "send_message", text: paragraphs },
      123,
    );

    expect(result?.ok).toBe(true);
    expect(proxyFetchMock).toHaveBeenCalledTimes(3);
    for (const call of proxyFetchMock.mock.calls) {
      expect(call[0]).toBe("https://webhook.example.com");
      const request = call[1] as {
        body: string;
        headers: Record<string, string>;
      };
      expect(request.headers["Content-Type"]).toBe("application/json");
      const card = JSON.parse(request.body) as Record<string, unknown>;
      expect(card.type).toBe("message");
      expect(card.attachments).toHaveLength(1);
    }
    expect(gateway.getMessageCount(123)).toBe(1);
  });

  it("does not increment message count when a webhook chunk fails", async () => {
    proxyFetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "temporarily unavailable",
      });
    const gateway = new Gateway();
    gateway.setContext(456);
    const handler = createTeamsActionHandler(
      "https://webhook.example.com",
      gateway,
    );

    const result = await handler(
      {
        action: "send_message",
        text: "first " + "x".repeat(9_900) + "\n\nsecond " + "y".repeat(9_900),
      },
      456,
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("503 temporarily unavailable"),
    });
    expect(gateway.getMessageCount(456)).toBe(0);
    expect(logError).toHaveBeenCalledWith(
      "teams",
      "send_message failed",
      expect.any(Error),
      { chatId: 456 },
    );
  });

  it("flattens button rows into Adaptive Card actions", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    });
    const gateway = new Gateway();
    gateway.setContext(789);
    const handler = createTeamsActionHandler(
      "https://webhook.example.com",
      gateway,
    );

    const result = await handler(
      {
        action: "send_message_with_buttons",
        text: "Choose",
        rows: [
          [
            { text: "Docs", url: "https://docs.example.com" },
            { text: "Confirm" },
          ],
        ],
      },
      789,
    );

    expect(result?.ok).toBe(true);
    const request = proxyFetchMock.mock.calls[0][1] as { body: string };
    const card = JSON.parse(request.body) as {
      attachments: Array<{
        content: { actions: Array<Record<string, unknown>> };
      }>;
    };
    expect(card.attachments[0].content.actions).toEqual([
      expect.objectContaining({
        type: "Action.OpenUrl",
        title: "Docs",
        url: "https://docs.example.com",
      }),
      expect.objectContaining({
        type: "Action.Submit",
        title: "Confirm",
        data: { choice: "Confirm" },
      }),
    ]);
    expect(gateway.getMessageCount(789)).toBe(1);
  });
});
