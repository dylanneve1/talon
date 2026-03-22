import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the log module before importing cron-store
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const existsSyncMock = vi.fn(() => false);
const readFileSyncMock = vi.fn(() => "{}");
const mkdirSyncMock = vi.fn();

// Mock fs to avoid real filesystem side effects
vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: vi.fn(),
  mkdirSync: mkdirSyncMock,
}));

const writeFileSyncMock = vi.fn();

vi.mock("write-file-atomic", () => ({
  default: { sync: writeFileSyncMock },
}));

import type { CronJob } from "../storage/cron-store.js";

const {
  loadCronJobs,
  flushCronJobs,
  addCronJob,
  getCronJob,
  getCronJobsForChat,
  getAllCronJobs,
  updateCronJob,
  deleteCronJob,
  recordCronRun,
  generateCronId,
  validateCronExpression,
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

    it("stores all fields correctly", () => {
      const job = makeCronJob({
        id: "test-add-full",
        chatId: "chat-full",
        schedule: "30 14 * * 1-5",
        type: "query",
        content: "What is the weather?",
        name: "Weather check",
        enabled: false,
        timezone: "Europe/London",
      });
      addCronJob(job);
      const retrieved = getCronJob("test-add-full")!;
      expect(retrieved.type).toBe("query");
      expect(retrieved.content).toBe("What is the weather?");
      expect(retrieved.enabled).toBe(false);
      expect(retrieved.timezone).toBe("Europe/London");
      expect(retrieved.schedule).toBe("30 14 * * 1-5");
    });

    it("overwrites existing job with same id", () => {
      addCronJob(makeCronJob({ id: "overwrite-1", name: "Original" }));
      addCronJob(makeCronJob({ id: "overwrite-1", name: "Replaced" }));
      const retrieved = getCronJob("overwrite-1")!;
      expect(retrieved.name).toBe("Replaced");
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

    it("can update schedule and content", () => {
      addCronJob(makeCronJob({ id: "update-sched" }));
      const updated = updateCronJob("update-sched", {
        schedule: "*/5 * * * *",
        content: "New content",
      });
      expect(updated!.schedule).toBe("*/5 * * * *");
      expect(updated!.content).toBe("New content");
    });

    it("can update lastRunAt and runCount", () => {
      addCronJob(makeCronJob({ id: "update-run" }));
      const ts = Date.now();
      const updated = updateCronJob("update-run", {
        lastRunAt: ts,
        runCount: 10,
      });
      expect(updated!.lastRunAt).toBe(ts);
      expect(updated!.runCount).toBe(10);
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

    it("job is no longer returned by getCronJobsForChat after deletion", () => {
      addCronJob(makeCronJob({ id: "del-chat-1", chatId: "del-chat" }));
      addCronJob(makeCronJob({ id: "del-chat-2", chatId: "del-chat" }));
      deleteCronJob("del-chat-1");
      const jobs = getCronJobsForChat("del-chat");
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe("del-chat-2");
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

    it("contains a timestamp component", () => {
      const id = generateCronId();
      const parts = id.split("_");
      expect(parts.length).toBe(3);
      const ts = Number(parts[1]);
      expect(ts).toBeGreaterThan(0);
      expect(ts).toBeLessThanOrEqual(Date.now());
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

    it("validates various valid cron patterns", () => {
      // Every 5 minutes
      expect(validateCronExpression("*/5 * * * *").valid).toBe(true);
      // Weekdays at noon
      expect(validateCronExpression("0 12 * * 1-5").valid).toBe(true);
      // First day of month at midnight
      expect(validateCronExpression("0 0 1 * *").valid).toBe(true);
      // Every hour
      expect(validateCronExpression("0 * * * *").valid).toBe(true);
    });

    it("rejects invalid timezone", () => {
      const result = validateCronExpression("0 9 * * *", "Not/A/Timezone");
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("validates with different valid timezones", () => {
      expect(validateCronExpression("0 9 * * *", "Europe/London").valid).toBe(true);
      expect(validateCronExpression("0 9 * * *", "Asia/Tokyo").valid).toBe(true);
      expect(validateCronExpression("0 9 * * *", "US/Pacific").valid).toBe(true);
    });

    it("returns no error field on valid expression", () => {
      const result = validateCronExpression("0 9 * * *");
      expect(result.error).toBeUndefined();
    });
  });

  describe("loadCronJobs", () => {
    it("loads jobs from object format file", () => {
      const stored = {
        "job-1": {
          id: "job-1",
          chatId: "chat-1",
          schedule: "0 9 * * *",
          type: "message",
          content: "Hello",
          name: "Greeting",
          enabled: true,
          createdAt: 1000,
          runCount: 5,
        },
        "job-2": {
          id: "job-2",
          chatId: "chat-2",
          schedule: "0 12 * * *",
          type: "query",
          content: "Status?",
          name: "Status check",
          enabled: false,
          createdAt: 2000,
          runCount: 0,
        },
      };
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue(JSON.stringify(stored));

      loadCronJobs();

      expect(getCronJob("job-1")).toBeDefined();
      expect(getCronJob("job-1")!.name).toBe("Greeting");
      expect(getCronJob("job-2")).toBeDefined();
      expect(getCronJob("job-2")!.type).toBe("query");
    });

    it("loads jobs from legacy array format", () => {
      const stored = [
        {
          id: "legacy-1",
          chatId: "chat-1",
          schedule: "0 9 * * *",
          type: "message",
          content: "Hello",
          name: "Greeting",
          enabled: true,
          createdAt: 1000,
          runCount: 0,
        },
        {
          id: "legacy-2",
          chatId: "chat-2",
          schedule: "0 12 * * *",
          type: "query",
          content: "Status?",
          name: "Status check",
          enabled: true,
          createdAt: 2000,
          runCount: 3,
        },
      ];
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue(JSON.stringify(stored));

      loadCronJobs();

      expect(getCronJob("legacy-1")).toBeDefined();
      expect(getCronJob("legacy-1")!.name).toBe("Greeting");
      expect(getCronJob("legacy-2")).toBeDefined();
    });

    it("does nothing when store file does not exist", () => {
      existsSyncMock.mockReturnValue(false);
      expect(() => loadCronJobs()).not.toThrow();
    });

    it("handles JSON parse errors gracefully (resets to empty)", () => {
      existsSyncMock.mockReturnValue(true);
      readFileSyncMock.mockReturnValue("not valid json{{{");

      expect(() => loadCronJobs()).not.toThrow();
    });
  });

  describe("flushCronJobs", () => {
    it("writes jobs to disk when dirty", () => {
      addCronJob(makeCronJob({ id: "flush-1" }));

      existsSyncMock.mockReturnValue(true);
      flushCronJobs();

      expect(writeFileSyncMock).toHaveBeenCalled();
      // Last write call is the actual data (earlier calls may be .bak backups)
      const lastCall = writeFileSyncMock.mock.calls[writeFileSyncMock.mock.calls.length - 1];
      const writtenData = lastCall[1] as string;
      const parsed = JSON.parse(writtenData.trim());
      expect(parsed["flush-1"]).toBeDefined();
    });

    it("creates workspace directory if it does not exist during addCronJob save", () => {
      // addCronJob calls save() internally, so we need to set up the mock
      // before calling addCronJob to catch the mkdir call
      existsSyncMock.mockReturnValue(false);
      mkdirSyncMock.mockClear();

      addCronJob(makeCronJob({ id: "flush-mkdir-1" }));

      expect(mkdirSyncMock).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it("does not write when not dirty", () => {
      // flushCronJobs calls save() which checks dirty flag.
      // Since we haven't modified anything since last flush, the writeFileSync
      // should not be called. But flushCronJobs doesn't set dirty=true like
      // flushHistory does. Let's verify that behavior.
      // Actually, looking at the code: flushCronJobs just calls save() directly
      // without setting dirty=true. So if nothing was modified, it won't write.
      writeFileSyncMock.mockClear();
      existsSyncMock.mockReturnValue(true);

      // Load cleans state, then flush immediately should be no-op
      existsSyncMock.mockReturnValue(false);
      loadCronJobs();
      writeFileSyncMock.mockClear();
      flushCronJobs();

      // After loadCronJobs + no changes, dirty is false, so save() should not write
      expect(writeFileSyncMock).not.toHaveBeenCalled();
    });
  });
});
