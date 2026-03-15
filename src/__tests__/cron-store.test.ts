import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the log module before importing cron-store
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// Mock fs to avoid real filesystem side effects
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

import type { CronJob } from "../storage/cron-store.js";

const {
  addCronJob,
  getCronJob,
  getCronJobsForChat,
  getAllCronJobs,
  updateCronJob,
  deleteCronJob,
  recordCronRun,
  generateCronId,
  validateCronExpression,
  loadCronJobs,
} = await import("../storage/cron-store.js");

function makeCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: generateCronId(),
    chatId: "chat-1",
    schedule: "0 9 * * *",
    type: "message",
    content: "Good morning!",
    name: "Morning greeting",
    enabled: true,
    createdAt: Date.now(),
    runCount: 0,
    ...overrides,
  };
}

describe("cron-store", () => {
  describe("addCronJob and getCronJob", () => {
    it("creates a job and it is retrievable", () => {
      const job = makeCronJob({ id: "test-add-1" });
      addCronJob(job);
      const retrieved = getCronJob("test-add-1");
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe("test-add-1");
      expect(retrieved!.name).toBe("Morning greeting");
      expect(retrieved!.schedule).toBe("0 9 * * *");
    });
  });

  describe("getCronJob", () => {
    it("returns undefined for nonexistent ID", () => {
      const result = getCronJob("nonexistent-id-xyz-999");
      expect(result).toBeUndefined();
    });
  });

  describe("getCronJobsForChat", () => {
    it("filters by chatId", () => {
      const jobA = makeCronJob({ id: "filter-a", chatId: "chat-filter-1" });
      const jobB = makeCronJob({ id: "filter-b", chatId: "chat-filter-2" });
      const jobC = makeCronJob({ id: "filter-c", chatId: "chat-filter-1" });
      addCronJob(jobA);
      addCronJob(jobB);
      addCronJob(jobC);

      const result = getCronJobsForChat("chat-filter-1");
      expect(result).toHaveLength(2);
      expect(result.map((j) => j.id)).toContain("filter-a");
      expect(result.map((j) => j.id)).toContain("filter-c");
    });

    it("returns empty array when no jobs match", () => {
      const result = getCronJobsForChat("no-jobs-here-123");
      expect(result).toEqual([]);
    });
  });

  describe("getAllCronJobs", () => {
    it("returns all jobs", () => {
      const before = getAllCronJobs().length;
      addCronJob(makeCronJob({ id: "all-1", chatId: "all-chat" }));
      addCronJob(makeCronJob({ id: "all-2", chatId: "all-chat" }));
      const after = getAllCronJobs().length;
      expect(after - before).toBe(2);
    });
  });

  describe("updateCronJob", () => {
    it("updates specific fields", () => {
      const job = makeCronJob({ id: "update-1", name: "Original" });
      addCronJob(job);

      const updated = updateCronJob("update-1", {
        name: "Updated",
        enabled: false,
      });

      expect(updated).toBeDefined();
      expect(updated!.name).toBe("Updated");
      expect(updated!.enabled).toBe(false);
      // Unchanged fields should remain
      expect(updated!.schedule).toBe("0 9 * * *");
      expect(updated!.chatId).toBe("chat-1");
    });

    it("returns undefined for nonexistent job", () => {
      const result = updateCronJob("nonexistent-update", { name: "nope" });
      expect(result).toBeUndefined();
    });
  });

  describe("deleteCronJob", () => {
    it("removes a job and returns true", () => {
      const job = makeCronJob({ id: "delete-1" });
      addCronJob(job);
      expect(getCronJob("delete-1")).toBeDefined();

      const result = deleteCronJob("delete-1");
      expect(result).toBe(true);
      expect(getCronJob("delete-1")).toBeUndefined();
    });

    it("returns false for nonexistent job", () => {
      const result = deleteCronJob("nonexistent-delete");
      expect(result).toBe(false);
    });
  });

  describe("recordCronRun", () => {
    it("increments runCount and sets lastRunAt", () => {
      const job = makeCronJob({ id: "run-1", runCount: 0 });
      addCronJob(job);

      recordCronRun("run-1");
      const after1 = getCronJob("run-1")!;
      expect(after1.runCount).toBe(1);
      expect(after1.lastRunAt).toBeGreaterThan(0);

      recordCronRun("run-1");
      const after2 = getCronJob("run-1")!;
      expect(after2.runCount).toBe(2);
    });

    it("is a no-op for nonexistent job", () => {
      // Should not throw
      expect(() => recordCronRun("nonexistent-run")).not.toThrow();
    });
  });

  describe("generateCronId", () => {
    it("returns unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateCronId());
      }
      expect(ids.size).toBe(100);
    });

    it("starts with 'cron_' prefix", () => {
      const id = generateCronId();
      expect(id.startsWith("cron_")).toBe(true);
    });
  });

  describe("validateCronExpression", () => {
    it("valid expression returns valid: true with next date", () => {
      const result = validateCronExpression("0 9 * * *");
      expect(result.valid).toBe(true);
      expect(result.next).toBeDefined();
      // next should be a valid ISO string
      expect(() => new Date(result.next!)).not.toThrow();
      expect(new Date(result.next!).getTime()).toBeGreaterThan(Date.now());
    });

    it("invalid expression returns valid: false with error", () => {
      const result = validateCronExpression("not a cron expression");
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("string");
    });

    it("accepts timezone parameter", () => {
      const result = validateCronExpression("0 9 * * *", "America/New_York");
      expect(result.valid).toBe(true);
      expect(result.next).toBeDefined();
    });
  });
});
