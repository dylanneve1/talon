/**
 * Extended tests for src/storage/cron-store.ts
 *
 * Covers edge cases not exercised by cron-store.test.ts:
 * - validateCronExpression edge cases (special expressions, bad timezone,
 *   next-run ISO string correctness)
 * - generateCronId uniqueness and format
 * - addCronJob / getCronJob roundtrip with all fields
 * - getCronJobsForChat isolation
 * - updateCronJob happy path and missing-ID guard
 * - deleteCronJob missing-ID guard
 * - recordCronRun increment semantics and missing-ID no-op
 * - getAllCronJobs
 * - loadCronJobs array (legacy) → object conversion
 * - loadCronJobs corrupt primary → backup fallback
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (before any dynamic import) ─────────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const existsSyncMock = vi.fn(() => false);
const readFileSyncMock = vi.fn(() => "{}");
const mkdirSyncMock = vi.fn();

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

vi.mock("../util/cleanup-registry.js", () => ({
  registerCleanup: vi.fn(),
}));

vi.mock("../util/paths.js", () => ({
  files: { cron: "/mock/data/cron.json" },
  dirs: {},
}));

// ── Dynamic import ─────────────────────────────────────────────────────────

import type { CronJob } from "../storage/cron-store.js";

const {
  loadCronJobs,
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

// ── Helpers ────────────────────────────────────────────────────────────────

let _seq = 0;
function uniqueId(): string {
  return `ext-cron-${++_seq}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: uniqueId(),
    chatId: "default-chat",
    schedule: "0 9 * * *",
    type: "message",
    content: "Hello!",
    name: "Test job",
    enabled: true,
    createdAt: Date.now(),
    runCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── validateCronExpression ─────────────────────────────────────────────────

describe("validateCronExpression", () => {
  it("standard 5-field expression is valid", () => {
    const r = validateCronExpression("0 9 * * *");
    expect(r.valid).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("next-run date is a valid ISO string in the future", () => {
    const r = validateCronExpression("0 9 * * *");
    expect(r.next).toBeDefined();
    const next = new Date(r.next!);
    expect(isNaN(next.getTime())).toBe(false);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it("every-minute expression '* * * * *' is valid", () => {
    const r = validateCronExpression("* * * * *");
    expect(r.valid).toBe(true);
  });

  it("every-5-minutes expression '*/5 * * * *' is valid", () => {
    const r = validateCronExpression("*/5 * * * *");
    expect(r.valid).toBe(true);
  });

  it("weekday-only expression '0 12 * * 1-5' is valid", () => {
    const r = validateCronExpression("0 12 * * 1-5");
    expect(r.valid).toBe(true);
  });

  it("first-of-month expression '0 0 1 * *' is valid", () => {
    const r = validateCronExpression("0 0 1 * *");
    expect(r.valid).toBe(true);
  });

  it("random string is invalid and returns error message", () => {
    const r = validateCronExpression("not a cron");
    expect(r.valid).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error!.length).toBeGreaterThan(0);
  });

  it("empty string is invalid", () => {
    const r = validateCronExpression("");
    expect(r.valid).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("expression with too few fields is invalid", () => {
    const r = validateCronExpression("* * *");
    expect(r.valid).toBe(false);
  });

  it("valid expression with valid timezone is accepted", () => {
    const r = validateCronExpression("0 9 * * *", "America/New_York");
    expect(r.valid).toBe(true);
    expect(r.next).toBeDefined();
  });

  it("valid expression with Europe/Warsaw timezone is accepted", () => {
    expect(validateCronExpression("30 8 * * *", "Europe/Warsaw").valid).toBe(
      true,
    );
  });

  it("valid expression with Asia/Tokyo timezone is accepted", () => {
    expect(validateCronExpression("0 6 * * *", "Asia/Tokyo").valid).toBe(true);
  });

  it("invalid timezone returns valid: false", () => {
    const r = validateCronExpression("0 9 * * *", "Not/A/Real/Timezone");
    expect(r.valid).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("invalid expression returns no 'next' field", () => {
    const r = validateCronExpression("garbage");
    expect(r.next).toBeUndefined();
  });

  it("valid expression without timezone still returns next", () => {
    const r = validateCronExpression("0 0 * * *");
    expect(r.valid).toBe(true);
    expect(r.next).toBeDefined();
  });
});

// ── generateCronId ─────────────────────────────────────────────────────────

describe("generateCronId", () => {
  it("produces IDs starting with 'cron_'", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateCronId()).toMatch(/^cron_/);
    }
  });

  it("produces IDs in cron_<uuid> format", () => {
    const id = generateCronId();
    const uuid = id.slice("cron_".length);
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("UUID part is version 4 (random)", () => {
    const id = generateCronId();
    const uuid = id.slice("cron_".length);
    // Version 4 UUID: 13th char is '4'
    expect(uuid[14]).toBe("4");
  });

  it("produces 100 unique IDs across rapid calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateCronId());
    }
    expect(ids.size).toBe(100);
  });
});

// ── addCronJob / getCronJob roundtrip ──────────────────────────────────────

describe("addCronJob and getCronJob roundtrip", () => {
  it("stores and retrieves a job with all fields intact", () => {
    const id = uniqueId();
    const job = makeJob({
      id,
      chatId: "roundtrip-chat",
      schedule: "*/15 * * * *",
      type: "query",
      content: "What is the weather today?",
      name: "Hourly weather",
      enabled: false,
      timezone: "Europe/London",
      runCount: 5,
    });
    addCronJob(job);

    const got = getCronJob(id)!;
    expect(got.id).toBe(id);
    expect(got.chatId).toBe("roundtrip-chat");
    expect(got.schedule).toBe("*/15 * * * *");
    expect(got.type).toBe("query");
    expect(got.content).toBe("What is the weather today?");
    expect(got.name).toBe("Hourly weather");
    expect(got.enabled).toBe(false);
    expect(got.timezone).toBe("Europe/London");
    expect(got.runCount).toBe(5);
  });

  it("getCronJob returns undefined for an ID that was never added", () => {
    expect(getCronJob("absolutely-not-a-real-id-xyz")).toBeUndefined();
  });

  it("adding a job with the same ID overwrites the previous one", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id, name: "First version" }));
    addCronJob(makeJob({ id, name: "Second version" }));
    expect(getCronJob(id)!.name).toBe("Second version");
  });

  it("addCronJob triggers a sync write (dirty flag is set)", () => {
    writeFileSyncMock.mockClear();
    existsSyncMock.mockReturnValue(false);
    addCronJob(makeJob());
    expect(writeFileSyncMock).toHaveBeenCalled();
  });
});

// ── getCronJobsForChat ─────────────────────────────────────────────────────

describe("getCronJobsForChat", () => {
  it("returns only jobs belonging to the specified chatId", () => {
    const chatA = `chat-A-${uniqueId()}`;
    const chatB = `chat-B-${uniqueId()}`;

    const idA1 = uniqueId();
    const idA2 = uniqueId();
    const idB1 = uniqueId();

    addCronJob(makeJob({ id: idA1, chatId: chatA }));
    addCronJob(makeJob({ id: idA2, chatId: chatA }));
    addCronJob(makeJob({ id: idB1, chatId: chatB }));

    const resultA = getCronJobsForChat(chatA);
    expect(resultA.map((j) => j.id)).toContain(idA1);
    expect(resultA.map((j) => j.id)).toContain(idA2);
    expect(resultA.map((j) => j.id)).not.toContain(idB1);

    const resultB = getCronJobsForChat(chatB);
    expect(resultB).toHaveLength(1);
    expect(resultB[0].id).toBe(idB1);
  });

  it("returns an empty array for a chat with no jobs", () => {
    expect(getCronJobsForChat("chat-with-zero-jobs-ext-xyz")).toEqual([]);
  });

  it("does not return a deleted job", () => {
    const chat = `del-chat-${uniqueId()}`;
    const id = uniqueId();
    addCronJob(makeJob({ id, chatId: chat }));
    deleteCronJob(id);
    expect(getCronJobsForChat(chat)).toEqual([]);
  });
});

// ── updateCronJob ──────────────────────────────────────────────────────────

describe("updateCronJob", () => {
  it("updates individual fields and returns the updated job", () => {
    const id = uniqueId();
    addCronJob(
      makeJob({ id, name: "Old name", enabled: true, schedule: "0 9 * * *" }),
    );

    const result = updateCronJob(id, { name: "New name", enabled: false });
    expect(result).toBeDefined();
    expect(result!.name).toBe("New name");
    expect(result!.enabled).toBe(false);
    // unchanged fields remain
    expect(result!.schedule).toBe("0 9 * * *");
  });

  it("returned job reference is the same object stored in getCronJob", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    const updated = updateCronJob(id, { name: "Check ref" });
    expect(updated).toBe(getCronJob(id));
  });

  it("returns undefined for a non-existent ID", () => {
    expect(
      updateCronJob("no-such-id-ext", { name: "irrelevant" }),
    ).toBeUndefined();
  });

  it("can update schedule and content simultaneously", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    const result = updateCronJob(id, {
      schedule: "*/10 * * * *",
      content: "updated content",
    });
    expect(result!.schedule).toBe("*/10 * * * *");
    expect(result!.content).toBe("updated content");
  });

  it("can update timezone", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    const result = updateCronJob(id, { timezone: "Pacific/Auckland" });
    expect(result!.timezone).toBe("Pacific/Auckland");
  });

  it("triggers a sync write after updating", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    writeFileSyncMock.mockClear();
    existsSyncMock.mockReturnValue(false);
    updateCronJob(id, { name: "write test" });
    expect(writeFileSyncMock).toHaveBeenCalled();
  });
});

// ── deleteCronJob ──────────────────────────────────────────────────────────

describe("deleteCronJob", () => {
  it("removes the job and returns true", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    expect(deleteCronJob(id)).toBe(true);
    expect(getCronJob(id)).toBeUndefined();
  });

  it("returns false for a non-existent ID", () => {
    expect(deleteCronJob("phantom-id-ext-999")).toBe(false);
  });

  it("deleting twice returns false on second call", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    expect(deleteCronJob(id)).toBe(true);
    expect(deleteCronJob(id)).toBe(false);
  });

  it("triggers a sync write", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    writeFileSyncMock.mockClear();
    existsSyncMock.mockReturnValue(false);
    deleteCronJob(id);
    expect(writeFileSyncMock).toHaveBeenCalled();
  });
});

// ── recordCronRun ──────────────────────────────────────────────────────────

describe("recordCronRun", () => {
  it("increments runCount from 0 to 1 on first call", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id, runCount: 0 }));
    recordCronRun(id);
    expect(getCronJob(id)!.runCount).toBe(1);
  });

  it("increments runCount on each successive call", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id, runCount: 0 }));
    recordCronRun(id);
    recordCronRun(id);
    recordCronRun(id);
    expect(getCronJob(id)!.runCount).toBe(3);
  });

  it("sets lastRunAt to a timestamp close to now", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    const before = Date.now();
    recordCronRun(id);
    const after = Date.now();

    const lastRun = getCronJob(id)!.lastRunAt!;
    expect(lastRun).toBeGreaterThanOrEqual(before);
    expect(lastRun).toBeLessThanOrEqual(after);
  });

  it("is a no-op (does not throw) for a non-existent ID", () => {
    expect(() => recordCronRun("non-existent-run-id-ext")).not.toThrow();
  });

  it("does not reset runCount when called on a job with existing runCount", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id, runCount: 10 }));
    recordCronRun(id);
    expect(getCronJob(id)!.runCount).toBe(11);
  });
});

// ── getAllCronJobs ─────────────────────────────────────────────────────────

describe("getAllCronJobs", () => {
  it("includes recently added jobs", () => {
    const id1 = uniqueId();
    const id2 = uniqueId();
    addCronJob(makeJob({ id: id1 }));
    addCronJob(makeJob({ id: id2 }));

    const all = getAllCronJobs();
    const ids = all.map((j) => j.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  it("does not include deleted jobs", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    deleteCronJob(id);
    const all = getAllCronJobs();
    expect(all.map((j) => j.id)).not.toContain(id);
  });

  it("returns an array (not an object)", () => {
    expect(Array.isArray(getAllCronJobs())).toBe(true);
  });
});

// ── loadCronJobs — legacy array format ────────────────────────────────────

describe("loadCronJobs — array (legacy) format", () => {
  it("converts array to object and makes jobs retrievable", () => {
    const legacy = [
      {
        id: "legacy-ext-1",
        chatId: "chat-legacy",
        schedule: "0 8 * * *",
        type: "message" as const,
        content: "Good morning",
        name: "Morning",
        enabled: true,
        createdAt: 1000,
        runCount: 2,
      },
      {
        id: "legacy-ext-2",
        chatId: "chat-legacy",
        schedule: "0 20 * * *",
        type: "query" as const,
        content: "Evening report",
        name: "Evening",
        enabled: false,
        createdAt: 2000,
        runCount: 0,
      },
    ];

    existsSyncMock.mockReturnValueOnce(true);
    readFileSyncMock.mockReturnValueOnce(JSON.stringify(legacy));

    loadCronJobs();

    expect(getCronJob("legacy-ext-1")).toBeDefined();
    expect(getCronJob("legacy-ext-1")!.name).toBe("Morning");
    expect(getCronJob("legacy-ext-2")).toBeDefined();
    expect(getCronJob("legacy-ext-2")!.type).toBe("query");
  });
});

// ── loadCronJobs — corrupt primary → backup fallback ──────────────────────

describe("loadCronJobs — corrupt primary tries backup", () => {
  it("falls back to backup when primary JSON is corrupt", () => {
    const backup = {
      "bak-ext-job": {
        id: "bak-ext-job",
        chatId: "bak-chat",
        schedule: "0 7 * * *",
        type: "message" as const,
        content: "From backup",
        name: "Backup job",
        enabled: true,
        createdAt: 3000,
        runCount: 0,
      },
    };

    // primary exists but is corrupt; backup exists and is valid
    existsSyncMock
      .mockReturnValueOnce(true) // primary existsSync
      .mockReturnValueOnce(true); // backup existsSync
    readFileSyncMock
      .mockReturnValueOnce("{{{ not json }}}") // primary read
      .mockReturnValueOnce(JSON.stringify(backup)); // backup read

    expect(() => loadCronJobs()).not.toThrow();
    expect(getCronJob("bak-ext-job")).toBeDefined();
    expect(getCronJob("bak-ext-job")!.name).toBe("Backup job");
  });

  it("does not throw when primary corrupt and backup does not exist (line 56 FALSE branch)", () => {
    // primary exists but corrupt; backup file does not exist → existsSync(bakFile) = false
    existsSyncMock
      .mockReturnValueOnce(true) // primary existsSync
      .mockReturnValueOnce(false); // backup existsSync → FALSE branch
    readFileSyncMock.mockReturnValueOnce("{{{ not json }}}");

    expect(() => loadCronJobs()).not.toThrow();
  });

  it("loads backup in array format when primary is corrupt (line 58 TRUE branch)", () => {
    const legacyArray = [
      {
        id: "bak-arr-1",
        chatId: "bak-chat",
        schedule: "0 6 * * *",
        type: "message" as const,
        content: "From array backup",
        name: "Array backup job",
        enabled: true,
        createdAt: 1000,
        runCount: 0,
      },
    ];

    // primary exists but corrupt; backup exists with array (legacy) format
    existsSyncMock
      .mockReturnValueOnce(true) // primary existsSync
      .mockReturnValueOnce(true); // backup existsSync
    readFileSyncMock
      .mockReturnValueOnce("{{{ not json }}}") // primary read
      .mockReturnValueOnce(JSON.stringify(legacyArray)); // backup read (array)

    loadCronJobs();

    expect(getCronJob("bak-arr-1")).toBeDefined();
    expect(getCronJob("bak-arr-1")!.name).toBe("Array backup job");
  });

  it("does not throw when both primary and backup are corrupt", () => {
    existsSyncMock
      .mockReturnValueOnce(true) // primary exists
      .mockReturnValueOnce(true); // backup exists
    readFileSyncMock
      .mockReturnValueOnce("BAD JSON PRIMARY")
      .mockReturnValueOnce("BAD JSON BACKUP");

    expect(() => loadCronJobs()).not.toThrow();
  });

  it("handles missing store file gracefully (does not throw)", () => {
    existsSyncMock.mockReturnValue(false);
    expect(() => loadCronJobs()).not.toThrow();
  });
});

// ── loadCronJobs — timezone validation ────────────────────────────────────

describe("loadCronJobs — invalid timezone stripping", () => {
  beforeEach(() => existsSyncMock.mockReset().mockReturnValue(false));

  it("strips invalid timezone from loaded job", async () => {
    await import("../storage/cron-store.js");
    const jobWithBadTz: Record<string, unknown> = {
      "tz-bad-id": {
        id: "tz-bad-id",
        chatId: "99",
        schedule: "0 * * * *",
        type: "message",
        content: "hi",
        name: "TZ Test",
        enabled: true,
        createdAt: Date.now(),
        runCount: 0,
        timezone: "Not/A_Real_Zone",
      },
    };
    existsSyncMock.mockReturnValueOnce(true).mockReturnValue(false);
    readFileSyncMock.mockReturnValueOnce(JSON.stringify(jobWithBadTz));
    loadCronJobs();
    const job = getCronJob("tz-bad-id");
    expect(job).toBeDefined();
    expect(job!.timezone).toBeUndefined();
  });

  it("preserves valid timezone on load", async () => {
    const jobWithGoodTz: Record<string, unknown> = {
      "tz-good-id": {
        id: "tz-good-id",
        chatId: "99",
        schedule: "0 * * * *",
        type: "message",
        content: "hi",
        name: "TZ Good",
        enabled: true,
        createdAt: Date.now(),
        runCount: 0,
        timezone: "Europe/Warsaw",
      },
    };
    existsSyncMock.mockReturnValueOnce(true).mockReturnValue(false);
    readFileSyncMock.mockReturnValueOnce(JSON.stringify(jobWithGoodTz));
    loadCronJobs();
    const job = getCronJob("tz-good-id");
    expect(job).toBeDefined();
    expect(job!.timezone).toBe("Europe/Warsaw");
  });
});

describe("isValidTimezone", () => {
  it("returns true for valid IANA timezones", async () => {
    const { isValidTimezone } = await import("../storage/cron-store.js");
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Europe/Warsaw")).toBe(true);
    expect(isValidTimezone("Asia/Tokyo")).toBe(true);
  });

  it("returns false for invalid timezone strings", async () => {
    const { isValidTimezone } = await import("../storage/cron-store.js");
    expect(isValidTimezone("Not/Real")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("BadString")).toBe(false);
  });
});
