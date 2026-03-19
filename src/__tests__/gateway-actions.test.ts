import { describe, it, expect, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

// Mock cron-store
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

const { handleSharedAction } = await import("../core/gateway-actions.js");

describe("gateway shared actions", () => {
  describe("fetch_url", () => {
    it("rejects missing URL", async () => {
      const result = await handleSharedAction({ action: "fetch_url" }, 123);
      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("Missing URL");
    });

    it("rejects non-http URLs", async () => {
      const result = await handleSharedAction({ action: "fetch_url", url: "ftp://example.com" }, 123);
      expect(result?.ok).toBe(false);
    });

    it("rejects malformed URLs", async () => {
      const result = await handleSharedAction({ action: "fetch_url", url: "not a url at all" }, 123);
      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("Invalid URL");
    });

    it("rejects javascript: protocol", async () => {
      const result = await handleSharedAction({ action: "fetch_url", url: "javascript:alert(1)" }, 123);
      expect(result?.ok).toBe(false);
    });

    it("rejects data: protocol", async () => {
      const result = await handleSharedAction({ action: "fetch_url", url: "data:text/html,<h1>hi</h1>" }, 123);
      expect(result?.ok).toBe(false);
    });
  });

  describe("cron CRUD", () => {
    it("creates a cron job", async () => {
      const result = await handleSharedAction({
        action: "create_cron_job",
        name: "test",
        schedule: "0 9 * * *",
        type: "message",
        content: "Good morning!",
      }, 123);
      expect(result?.ok).toBe(true);
      expect(result?.text).toContain("Created cron job");
    });

    it("rejects cron without schedule", async () => {
      const result = await handleSharedAction({
        action: "create_cron_job", name: "test", content: "hi",
      }, 123);
      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("Missing schedule");
    });

    it("rejects cron without content", async () => {
      const result = await handleSharedAction({
        action: "create_cron_job", name: "test", schedule: "0 9 * * *",
      }, 123);
      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("Missing content");
    });

    it("rejects oversized content", async () => {
      const result = await handleSharedAction({
        action: "create_cron_job", name: "test", schedule: "0 9 * * *",
        content: "x".repeat(11000),
      }, 123);
      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("too long");
    });

    it("lists cron jobs", async () => {
      const result = await handleSharedAction({ action: "list_cron_jobs" }, 123);
      expect(result?.ok).toBe(true);
      expect(result?.text).toContain("No cron jobs");
    });
  });

  describe("history", () => {
    it("read_history returns messages", async () => {
      const result = await handleSharedAction({ action: "read_history" }, 123);
      expect(result?.ok).toBe(true);
    });

    it("search_history works", async () => {
      const result = await handleSharedAction({ action: "search_history", query: "test" }, 123);
      expect(result?.ok).toBe(true);
    });

    it("list_known_users works", async () => {
      const result = await handleSharedAction({ action: "list_known_users" }, 123);
      expect(result?.ok).toBe(true);
    });
  });

  describe("unknown actions", () => {
    it("returns null for unknown actions", async () => {
      const result = await handleSharedAction({ action: "unknown_thing" }, 123);
      expect(result).toBeNull();
    });
  });
});
