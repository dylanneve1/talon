import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
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

vi.mock("../core/dispatcher.js", () => ({
  getActiveCount: vi.fn(() => 0),
}));

// Mock cron-store for shared actions
vi.mock("../storage/cron-store.js", () => ({
  addCronJob: vi.fn(),
  getCronJob: vi.fn(),
  getCronJobsForChat: vi.fn(() => []),
  updateCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  validateCronExpression: vi.fn(() => ({
    valid: true,
    next: new Date().toISOString(),
  })),
  generateCronId: vi.fn(() => "test-id"),
  loadCronJobs: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

import { Gateway } from "../core/gateway.js";

let gateway: Gateway;
let port: number;

// Mock frontend handler
const mockFrontendHandler = vi.fn(async (body: Record<string, unknown>) => {
  const action = body.action as string;
  if (action === "send_message")
    return { ok: true, message_id: 42, text: "sent" };
  if (action === "get_chat_info") return { ok: true, id: 123, type: "private" };
  return null;
});

beforeAll(async () => {
  gateway = new Gateway();
  gateway.setFrontendHandler(mockFrontendHandler);
  port = await gateway.start(19899); // test port
});

afterAll(async () => {
  await gateway.stop();
});

beforeEach(() => {
  // Clear contexts for known test chatIds
  for (const id of [123, 999]) {
    gateway.clearContext(id);
    gateway.clearContext(id);
  }
  mockFrontendHandler.mockClear();
});

async function post(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(`http://127.0.0.1:${port}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: resp.status,
    body: (await resp.json()) as Record<string, unknown>,
  };
}

describe("gateway HTTP server", () => {
  describe("health endpoint", () => {
    it("returns health JSON", async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      expect(resp.status).toBe(200);
      const data = (await resp.json()) as Record<string, unknown>;
      expect(data.ok).toBeDefined();
      expect(data.uptime).toBeDefined();
      expect(data.memory).toBeDefined();
    });
  });

  describe("404 handling", () => {
    it("returns 404 for unknown paths", async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/nonexistent`);
      expect(resp.status).toBe(404);
    });

    it("returns 404 for GET /action", async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/action`);
      expect(resp.status).toBe(404);
    });
  });

  describe("malformed requests", () => {
    it("returns 400 for invalid JSON", async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      });
      expect(resp.status).toBe(400);
      const data = (await resp.json()) as Record<string, unknown>;
      expect(data.ok).toBe(false);
      expect(data.error).toContain("Invalid JSON");
    });

    it("returns 413 for oversized action bodies", async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send_message",
          text: "x".repeat(1024 * 1024),
        }),
      });
      expect(resp.status).toBe(413);
      const data = (await resp.json()) as Record<string, unknown>;
      expect(data.ok).toBe(false);
      expect(data.error).toContain("too large");
      expect(data.reason).toBe("bad_request");
      expect(data.requestId).toBeTruthy();
    });
  });

  describe("action routing", () => {
    it("returns error when no active context", async () => {
      const { body } = await post({ action: "send_message", text: "hi" });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
    });

    it("routes to shared actions (cron)", async () => {
      gateway.setContext(123);
      const { body } = await post({ action: "list_cron_jobs", _chatId: "123" });
      expect(body.ok).toBe(true);
      gateway.clearContext(123);
    });

    it("routes to frontend handler", async () => {
      gateway.setContext(123);
      const { body } = await post({
        action: "send_message",
        _chatId: "123",
        text: "hello",
      });
      expect(body.ok).toBe(true);
      expect(body.message_id).toBe(42);
      expect(mockFrontendHandler).toHaveBeenCalled();
      gateway.clearContext(123);
    });

    it("returns error for unknown action", async () => {
      gateway.setContext(123);
      const { body } = await post({
        action: "completely_unknown_action",
        _chatId: "123",
      });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Unknown action");
      gateway.clearContext(123);
    });

    it("returns error for missing action field", async () => {
      gateway.setContext(123);
      const { body } = await post({ _chatId: "123", text: "no action" });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Missing action");
      gateway.clearContext(123);
    });

    it("rejects unknown chatId (no active context)", async () => {
      const { body } = await post({ action: "send_message", _chatId: "999" });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
    });
  });

  describe("concurrent chat contexts via HTTP", () => {
    it("handles two chats simultaneously", async () => {
      gateway.setContext(100);
      gateway.setContext(200);

      const [r1, r2] = await Promise.all([
        post({ action: "send_message", _chatId: "100", text: "from chat 100" }),
        post({ action: "send_message", _chatId: "200", text: "from chat 200" }),
      ]);

      expect(r1.body.ok).toBe(true);
      expect(r2.body.ok).toBe(true);
      expect(mockFrontendHandler).toHaveBeenCalledTimes(2);

      gateway.clearContext(100);
      gateway.clearContext(200);
    });

    it("one chat's context doesn't affect another", async () => {
      gateway.setContext(300);
      // Chat 400 has no context
      const { body } = await post({
        action: "send_message",
        _chatId: "400",
        text: "no context",
      });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
      // Chat 300 still works
      const r2 = await post({
        action: "send_message",
        _chatId: "300",
        text: "still works",
      });
      expect(r2.body.ok).toBe(true);
      gateway.clearContext(300);
    });

    it("frontend handler error returns error result (doesn't crash server)", async () => {
      const errorHandler = vi.fn(async () => {
        throw new Error("handler exploded");
      });
      gateway.setFrontendHandler(errorHandler);
      gateway.setContext(123);

      const { status, body } = await post({
        action: "send_message",
        _chatId: "123",
        text: "boom",
      });

      expect(status).toBe(200); // HTTP 200, error in body
      expect(body.ok).toBe(false);
      expect(body.error).toContain("handler exploded");

      gateway.clearContext(123);
      gateway.setFrontendHandler(mockFrontendHandler); // restore
    });

    it("request without _chatId is rejected", async () => {
      gateway.setContext(123);
      const { body } = await post({
        action: "send_message",
        text: "no chatId",
      });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
      gateway.clearContext(123);
    });

    it("returns 500 when handleAction result cannot be JSON-serialized", async () => {
      // Make frontendHandler return a circular reference so JSON.stringify throws
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;
      const circularHandler = vi.fn(
        async () => circular,
      ) as unknown as import("../core/types.js").FrontendActionHandler;
      gateway.setFrontendHandler(circularHandler);
      gateway.setContext(123);

      const { status, body } = await post({
        action: "send_message",
        _chatId: "123",
        text: "boom",
      });

      expect(status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error).toBeTruthy();

      gateway.clearContext(123);
      gateway.setFrontendHandler(mockFrontendHandler); // restore
    });
  });

  describe("shared actions via HTTP", () => {
    it("fetch_url rejects invalid URLs", async () => {
      gateway.setContext(123);
      const { body } = await post({
        action: "fetch_url",
        _chatId: "123",
        url: "not-a-url",
      });
      expect(body.ok).toBe(false);
      gateway.clearContext(123);
    });

    it("read_history returns ok", async () => {
      gateway.setContext(123);
      const { body } = await post({ action: "read_history", _chatId: "123" });
      expect(body.ok).toBe(true);
      gateway.clearContext(123);
    });

    it("create_cron_job works", async () => {
      gateway.setContext(123);
      const { body } = await post({
        action: "create_cron_job",
        _chatId: "123",
        name: "test",
        schedule: "0 9 * * *",
        type: "message",
        content: "hello",
      });
      expect(body.ok).toBe(true);
      gateway.clearContext(123);
    });
  });
});

// ── Plugin action route coverage ─────────────────────────────────────────────

describe("gateway routes to plugin handler", () => {
  it("returns plugin result when handlePluginAction returns non-null", async () => {
    const { handlePluginAction } = await import("../core/plugin.js");
    (handlePluginAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      result: "from plugin",
    });

    gateway.setContext(123);
    const { body } = await post({
      action: "plugin_specific_action",
      _chatId: "123",
    });
    expect(body.ok).toBe(true);
    expect(body.result).toBe("from plugin");
    gateway.clearContext(123);

    // Restore to always-null for subsequent tests
    (handlePluginAction as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });
});

// ── Additional branch coverage ────────────────────────────────────────────

describe("gateway — no frontend handler falls through to shared actions (line 162 FALSE branch)", () => {
  it("routes to shared action when frontendHandler is null", async () => {
    // Clear frontend handler — FALSE branch of `if (this.frontendHandler)`
    gateway.setFrontendHandler(null);
    gateway.setContext(123);

    // read_history is a shared action that should still work
    const { body } = await post({ action: "read_history", _chatId: "123" });
    expect(body.ok).toBe(true);

    gateway.clearContext(123);
    gateway.setFrontendHandler(mockFrontendHandler); // restore
  });
});

describe("gateway — non-Error thrown in handleAction catch (line 186 FALSE branch)", () => {
  it("returns error with String(err) when handler throws a non-Error", async () => {
    const stringThrowHandler = vi.fn(async () => {
      throw "plain string gateway error";
    });
    gateway.setFrontendHandler(stringThrowHandler);
    gateway.setContext(123);

    const { body } = await post({
      action: "send_message",
      _chatId: "123",
      text: "test",
    });
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("plain string gateway error");

    gateway.clearContext(123);
    gateway.setFrontendHandler(mockFrontendHandler); // restore
  });
});

describe("gateway — start() called twice returns same port (line 195 TRUE branch)", () => {
  it("returns port without restarting when already running", async () => {
    // gateway is already started — calling start() again should return same port immediately
    const secondPort = await gateway.start();
    expect(secondPort).toBe(port);
  });
});

describe("gateway health endpoint — old activity shows minutes ago (line 211 FALSE branch)", () => {
  it("shows 'Xm ago' when msSinceLastMessage >= 60000", async () => {
    const { getHealthStatus } = await import("../util/watchdog.js");
    (getHealthStatus as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      healthy: true,
      totalMessagesProcessed: 5,
      recentErrorCount: 0,
      msSinceLastMessage: 5 * 60_000, // 5 minutes ago → > 60000
    });

    const resp = await fetch(`http://127.0.0.1:${port}/health`);
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.lastActivity).toMatch(/m ago$/);
  });
});

// ── Port retry (EADDRINUSE) ───────────────────────────────────────────────

describe("gateway port retry — EADDRINUSE", () => {
  it("rejects when all retry attempts are exhausted (6 consecutive ports in use)", async () => {
    // The retry logic allows attempt 0-4 (5 retries), trying ports p, p+1, …, p+5
    // Block all 6 consecutive ports so every attempt fails → should reject
    const blockers: Array<import("node:http").Server> = [];
    for (let p = 19950; p <= 19955; p++) {
      const { createServer } = await import("node:http");
      const s = createServer();
      await new Promise<void>((resolve) => s.listen(p, "127.0.0.1", resolve));
      blockers.push(s);
    }

    try {
      const gw = new Gateway();
      gw.setFrontendHandler(async () => null);
      await expect(gw.start(19950)).rejects.toThrow();
    } finally {
      for (const s of blockers) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    }
  });
});
