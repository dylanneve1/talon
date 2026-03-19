import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(),
}));

vi.mock("../core/plugin.js", () => ({
  handlePluginAction: vi.fn(async () => null),
}));

vi.mock("../util/watchdog.js", () => ({
  getHealthStatus: vi.fn(() => ({
    healthy: true, totalMessagesProcessed: 0, recentErrorCount: 0, msSinceLastMessage: 0,
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
  validateCronExpression: vi.fn(() => ({ valid: true, next: new Date().toISOString() })),
  generateCronId: vi.fn(() => "test-id"),
  loadCronJobs: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

const {
  startGateway,
  stopGateway,
  setGatewayContext,
  clearGatewayContext,
  setFrontendHandler,
} = await import("../core/gateway.js");

let port: number;

// Mock frontend handler
const mockFrontendHandler = vi.fn(async (body: Record<string, unknown>) => {
  const action = body.action as string;
  if (action === "send_message") return { ok: true, message_id: 42, text: "sent" };
  if (action === "get_chat_info") return { ok: true, id: 123, type: "private" };
  return null;
});

beforeAll(async () => {
  setFrontendHandler(mockFrontendHandler);
  port = await startGateway(19899); // test port
});

afterAll(async () => {
  await stopGateway();
});

beforeEach(() => {
  for (let i = 0; i < 10; i++) clearGatewayContext();
  mockFrontendHandler.mockClear();
});

async function post(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(`http://127.0.0.1:${port}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json() as Record<string, unknown> };
}

describe("gateway HTTP server", () => {
  describe("health endpoint", () => {
    it("returns health JSON", async () => {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      expect(resp.status).toBe(200);
      const data = await resp.json() as Record<string, unknown>;
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
      const data = await resp.json() as Record<string, unknown>;
      expect(data.ok).toBe(false);
      expect(data.error).toContain("Invalid JSON");
    });
  });

  describe("action routing", () => {
    it("returns error when no active context", async () => {
      const { body } = await post({ action: "send_message", text: "hi" });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
    });

    it("routes to shared actions (cron)", async () => {
      setGatewayContext(123);
      const { body } = await post({ action: "list_cron_jobs", _chatId: "123" });
      expect(body.ok).toBe(true);
      clearGatewayContext(123);
    });

    it("routes to frontend handler", async () => {
      setGatewayContext(123);
      const { body } = await post({ action: "send_message", _chatId: "123", text: "hello" });
      expect(body.ok).toBe(true);
      expect(body.message_id).toBe(42);
      expect(mockFrontendHandler).toHaveBeenCalled();
      clearGatewayContext(123);
    });

    it("returns error for unknown action", async () => {
      setGatewayContext(123);
      const { body } = await post({ action: "completely_unknown_action", _chatId: "123" });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Unknown action");
      clearGatewayContext(123);
    });

    it("returns error for missing action field", async () => {
      setGatewayContext(123);
      const { body } = await post({ _chatId: "123", text: "no action" });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Missing action");
      clearGatewayContext(123);
    });

    it("rejects unknown chatId (no active context)", async () => {
      const { body } = await post({ action: "send_message", _chatId: "999" });
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No active chat context");
    });
  });

  describe("shared actions via HTTP", () => {
    it("fetch_url rejects invalid URLs", async () => {
      setGatewayContext(123);
      const { body } = await post({ action: "fetch_url", _chatId: "123", url: "not-a-url" });
      expect(body.ok).toBe(false);
      clearGatewayContext(123);
    });

    it("read_history returns ok", async () => {
      setGatewayContext(123);
      const { body } = await post({ action: "read_history", _chatId: "123" });
      expect(body.ok).toBe(true);
      clearGatewayContext(123);
    });

    it("create_cron_job works", async () => {
      setGatewayContext(123);
      const { body } = await post({
        action: "create_cron_job", _chatId: "123",
        name: "test", schedule: "0 9 * * *", type: "message", content: "hello",
      });
      expect(body.ok).toBe(true);
      clearGatewayContext(123);
    });
  });
});
