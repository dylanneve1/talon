/**
 * Tests for the pure scheduler helpers in src/storage/cron-store.ts that back
 * the interval/cron scheduling rewrite:
 *
 *   - isIntervalJob        — cron-mode vs interval-mode discrimination
 *   - intervalAnchor       — lastRunAt ?? startAt ?? createdAt precedence
 *   - nextRunAt            — cron mode, interval mode, startAt-in-future gating,
 *                            past-endAt => null, unparseable cron => null
 *   - describeSchedule     — cron expression vs "every 90m" style
 *   - humanizeMs           — s / m / h / d boundaries and fractional rendering
 *   - isCronJob (indirect, via the store migrate path) — accepts schedule-only
 *                            and everyMs-only, rejects neither
 *   - recordCronRun        — ok clears lastError, error sets it, durationMs,
 *                            and the optional `at` override of lastRunAt/runCount
 *
 * Mirrors the harness in cron-store-extended.test.ts: node:fs is fully mocked so
 * the store never touches disk, paths are stubbed, and every job gets a unique
 * id so module-level store state never bleeds between cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must precede the dynamic import) ────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const existsSyncMock = vi.fn(() => false);
const readFileSyncMock = vi.fn(() => "{}");
const mkdirSyncMock = vi.fn();
const renameSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: vi.fn(),
  mkdirSync: mkdirSyncMock,
  renameSync: renameSyncMock,
  unlinkSync: unlinkSyncMock,
}));

const writeFileSyncMock = vi.fn();
vi.mock("write-file-atomic", () => ({
  default: Object.assign((...args: unknown[]) => writeFileSyncMock(...args), {
    sync: writeFileSyncMock,
  }),
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
  isIntervalJob,
  intervalAnchor,
  nextRunAt,
  describeSchedule,
  humanizeMs,
  addCronJob,
  getCronJob,
  recordCronRun,
  loadCronJobs,
} = await import("../storage/cron-store.js");

// ── Helpers ────────────────────────────────────────────────────────────────

let _seq = 0;
function uniqueId(): string {
  return `sched-cron-${++_seq}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: uniqueId(),
    chatId: "sched-chat",
    schedule: "0 9 * * *",
    type: "message",
    content: "Hello!",
    name: "Test job",
    enabled: true,
    createdAt: 1_000_000,
    runCount: 0,
    ...overrides,
  };
}

/** An interval job has no cron expression and a positive everyMs. */
function makeIntervalJob(overrides: Partial<CronJob> = {}): CronJob {
  return makeJob({ schedule: undefined, everyMs: 60_000, ...overrides });
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
});

// ── isIntervalJob ────────────────────────────────────────────────────────────

describe("isIntervalJob", () => {
  it("is false for a cron-mode job (schedule, no everyMs)", () => {
    expect(isIntervalJob(makeJob())).toBe(false);
  });

  it("is true for an interval-mode job with positive everyMs", () => {
    expect(isIntervalJob(makeIntervalJob({ everyMs: 90 * MINUTE }))).toBe(true);
  });

  it("is false when everyMs is 0", () => {
    // everyMs:0 is not a valid interval — falls back to cron semantics.
    expect(isIntervalJob(makeJob({ everyMs: 0 }))).toBe(false);
  });

  it("is false when everyMs is negative", () => {
    expect(isIntervalJob(makeJob({ everyMs: -5_000 }))).toBe(false);
  });

  it("is false when everyMs is undefined (legacy job)", () => {
    expect(isIntervalJob(makeJob({ everyMs: undefined }))).toBe(false);
  });

  it("treats everyMs as authoritative even if a schedule is also present", () => {
    // The store forbids both, but the helper keys purely off everyMs.
    expect(
      isIntervalJob(makeJob({ schedule: "0 9 * * *", everyMs: 60_000 })),
    ).toBe(true);
  });
});

// ── intervalAnchor ───────────────────────────────────────────────────────────

describe("intervalAnchor", () => {
  it("falls back to createdAt when nothing else is set", () => {
    const job = makeIntervalJob({ createdAt: 5000 });
    expect(intervalAnchor(job)).toBe(5000);
  });

  it("prefers startAt over createdAt", () => {
    const job = makeIntervalJob({ createdAt: 5000, startAt: 9000 });
    expect(intervalAnchor(job)).toBe(9000);
  });

  it("prefers lastRunAt over both startAt and createdAt", () => {
    const job = makeIntervalJob({
      createdAt: 5000,
      startAt: 9000,
      lastRunAt: 12000,
    });
    expect(intervalAnchor(job)).toBe(12000);
  });

  it("uses lastRunAt of 0 only if it were set, otherwise startAt (?? not ||)", () => {
    // lastRunAt unset -> startAt; this guards against a truthiness bug.
    const job = makeIntervalJob({
      createdAt: 5000,
      startAt: 9000,
      lastRunAt: undefined,
    });
    expect(intervalAnchor(job)).toBe(9000);
  });
});

// ── nextRunAt — interval mode ────────────────────────────────────────────────

describe("nextRunAt — interval mode", () => {
  it("fires one interval after the anchor for a fresh job", () => {
    // anchor = createdAt = 1_000_000, every = 1 min, from at the anchor.
    const job = makeIntervalJob({ everyMs: MINUTE, createdAt: 1_000_000 });
    expect(nextRunAt(job, 1_000_000)).toBe(1_000_000 + MINUTE);
  });

  it("counts from lastRunAt once the job has run", () => {
    const job = makeIntervalJob({
      everyMs: MINUTE,
      createdAt: 1_000_000,
      lastRunAt: 1_500_000,
    });
    // Asking right at lastRunAt -> next is one interval later.
    expect(nextRunAt(job, 1_500_000)).toBe(1_500_000 + MINUTE);
  });

  it("skips ahead past many missed intervals to the next future fire", () => {
    // anchor 0, every 1 min, now is 10.5 minutes later -> next is minute 11.
    const job = makeIntervalJob({ everyMs: MINUTE, createdAt: 0 });
    const now = 10 * MINUTE + 30_000;
    expect(nextRunAt(job, now)).toBe(11 * MINUTE);
  });

  it("returns the first multiple strictly after `from` when from lands on a boundary", () => {
    // anchor 0, every 1 min, from exactly on minute 5 -> next is minute 6
    // (nextDueMs is strictly-after, and nextRunAt asks for at-or-after `from`,
    //  so a boundary `from` is itself a valid fire => returned).
    const job = makeIntervalJob({ everyMs: MINUTE, createdAt: 0 });
    expect(nextRunAt(job, 5 * MINUTE)).toBe(5 * MINUTE);
  });

  it("returns a boundary `from` itself (at-or-after semantics)", () => {
    const job = makeIntervalJob({ everyMs: MINUTE, createdAt: 0 });
    // from = exactly minute 3; that instant is a fire time and is returned.
    expect(nextRunAt(job, 3 * MINUTE)).toBe(3 * MINUTE);
  });
});

// ── nextRunAt — startAt gating ───────────────────────────────────────────────

describe("nextRunAt — startAt in the future", () => {
  it("interval: never fires before startAt; counts from startAt floor", () => {
    // startAt is in the future relative to `from`; the first eligible fire is
    // computed from the startAt floor, not `from`.
    const job = makeIntervalJob({
      everyMs: MINUTE,
      createdAt: 0,
      startAt: 10 * MINUTE,
    });
    // anchor = startAt = 10m (startAt beats createdAt). from = 1m, floor = 10m.
    // floor lands on a fire boundary (anchor + 0) -> returned as-is.
    const next = nextRunAt(job, MINUTE);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThanOrEqual(10 * MINUTE);
  });

  it("interval: result is never before startAt", () => {
    const job = makeIntervalJob({
      everyMs: 5 * MINUTE,
      createdAt: 0,
      startAt: 100 * MINUTE,
    });
    const next = nextRunAt(job, 0);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThanOrEqual(100 * MINUTE);
  });

  it("cron: does not return a fire time before startAt", () => {
    // Daily at 09:00 UTC. startAt forced far in the future -> the returned
    // next must be at or after startAt.
    const startAt = Date.UTC(2030, 0, 1, 0, 0, 0);
    const job = makeJob({
      schedule: "0 9 * * *",
      timezone: "UTC",
      startAt,
    });
    const next = nextRunAt(job, Date.UTC(2026, 0, 1));
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThanOrEqual(startAt);
  });
});

// ── nextRunAt — cron mode ────────────────────────────────────────────────────

describe("nextRunAt — cron mode", () => {
  it("computes the next daily fire from a known instant", () => {
    // 09:00 UTC daily. from = 2026-06-17T08:00Z -> next is same day 09:00Z.
    const job = makeJob({ schedule: "0 9 * * *", timezone: "UTC" });
    const from = Date.UTC(2026, 5, 17, 8, 0, 0);
    expect(nextRunAt(job, from)).toBe(Date.UTC(2026, 5, 17, 9, 0, 0));
  });

  it("rolls to the next day when `from` is past today's fire", () => {
    const job = makeJob({ schedule: "0 9 * * *", timezone: "UTC" });
    const from = Date.UTC(2026, 5, 17, 10, 0, 0); // after 09:00
    expect(nextRunAt(job, from)).toBe(Date.UTC(2026, 5, 18, 9, 0, 0));
  });

  it("returns a strictly future time for an every-minute job", () => {
    const job = makeJob({ schedule: "* * * * *" });
    const from = Date.now();
    const next = nextRunAt(job, from);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(from);
    expect(next!).toBeLessThanOrEqual(from + 2 * MINUTE);
  });

  it("returns null for an unparseable cron expression", () => {
    const job = makeJob({ schedule: "this is not cron" });
    expect(nextRunAt(job)).toBeNull();
  });
});

// ── nextRunAt — endAt expiry ─────────────────────────────────────────────────

describe("nextRunAt — past endAt", () => {
  it("cron: returns null when the next fire is after endAt", () => {
    // Next daily fire would be tomorrow 09:00 but endAt is before that.
    const job = makeJob({
      schedule: "0 9 * * *",
      timezone: "UTC",
      endAt: Date.UTC(2026, 5, 17, 9, 0, 0),
    });
    // from after today's fire -> next would be tomorrow 09:00 > endAt -> null.
    const from = Date.UTC(2026, 5, 17, 12, 0, 0);
    expect(nextRunAt(job, from)).toBeNull();
  });

  it("cron: still returns the fire when it lands at or before endAt", () => {
    const job = makeJob({
      schedule: "0 9 * * *",
      timezone: "UTC",
      endAt: Date.UTC(2026, 5, 17, 9, 0, 0),
    });
    const from = Date.UTC(2026, 5, 17, 8, 0, 0); // before today's fire
    // next == endAt exactly -> allowed (next > endAt is the cutoff).
    expect(nextRunAt(job, from)).toBe(Date.UTC(2026, 5, 17, 9, 0, 0));
  });

  it("interval: returns null once the next fire would exceed endAt", () => {
    const job = makeIntervalJob({
      everyMs: MINUTE,
      createdAt: 0,
      endAt: 5 * MINUTE,
    });
    // from at minute 10 -> next fire minute 10 > endAt(5m) -> null.
    expect(nextRunAt(job, 10 * MINUTE)).toBeNull();
  });

  it("interval: returns the fire when it is within endAt", () => {
    const job = makeIntervalJob({
      everyMs: MINUTE,
      createdAt: 0,
      endAt: 100 * MINUTE,
    });
    expect(nextRunAt(job, 3 * MINUTE)).toBe(3 * MINUTE);
  });
});

// ── describeSchedule ─────────────────────────────────────────────────────────

describe("describeSchedule", () => {
  it("returns the raw cron expression for a cron-mode job", () => {
    expect(describeSchedule(makeJob({ schedule: "*/15 * * * *" }))).toBe(
      "*/15 * * * *",
    );
  });

  it("renders a sub-hour interval job as 'every <Nm>'", () => {
    // 45 min stays in the minute band (m < 60) -> "45m". (90 min would be
    // 1.5h, since humanizeMs promotes to hours once m >= 60.)
    expect(describeSchedule(makeIntervalJob({ everyMs: 45 * MINUTE }))).toBe(
      "every 45m",
    );
  });

  it("renders a 90-minute interval as 'every 1.5h' (hour promotion)", () => {
    expect(describeSchedule(makeIntervalJob({ everyMs: 90 * MINUTE }))).toBe(
      "every 1.5h",
    );
  });

  it("renders an hourly interval as 'every 1h'", () => {
    expect(describeSchedule(makeIntervalJob({ everyMs: HOUR }))).toBe(
      "every 1h",
    );
  });

  it("falls back to a placeholder when neither schedule nor interval is set", () => {
    // Defensive: should never happen for a valid stored job, but the helper
    // must not crash.
    const job = makeJob({ schedule: undefined, everyMs: undefined });
    expect(describeSchedule(job)).toBe("(no schedule)");
  });
});

// ── humanizeMs ───────────────────────────────────────────────────────────────

describe("humanizeMs", () => {
  it("renders sub-minute durations in seconds", () => {
    expect(humanizeMs(30_000)).toBe("30s");
    expect(humanizeMs(1_000)).toBe("1s");
    expect(humanizeMs(59_000)).toBe("59s");
  });

  it("renders exactly one minute as 1m", () => {
    expect(humanizeMs(MINUTE)).toBe("1m");
  });

  it("renders whole-minute durations (still in the minute band) as Nm", () => {
    // Stay under 60 minutes; at/above 60 min humanizeMs promotes to hours.
    expect(humanizeMs(45 * MINUTE)).toBe("45m");
    expect(humanizeMs(5 * MINUTE)).toBe("5m");
    expect(humanizeMs(59 * MINUTE)).toBe("59m");
  });

  it("promotes 90 minutes to the hour band as 1.5h", () => {
    expect(humanizeMs(90 * MINUTE)).toBe("1.5h");
  });

  it("renders exactly one hour as 1h", () => {
    expect(humanizeMs(HOUR)).toBe("1h");
  });

  it("renders whole-hour durations as Nh", () => {
    expect(humanizeMs(2 * HOUR)).toBe("2h");
    expect(humanizeMs(23 * HOUR)).toBe("23h");
  });

  it("renders fractional hours with one decimal", () => {
    // 2.5h = 150 min; m >= 60 so it promotes to hours, h not integer -> "2.5h".
    expect(humanizeMs(2.5 * HOUR)).toBe("2.5h");
  });

  it("renders exactly one day as 1d", () => {
    expect(humanizeMs(DAY)).toBe("1d");
  });

  it("renders whole-day durations as Nd", () => {
    expect(humanizeMs(7 * DAY)).toBe("7d");
  });

  it("renders fractional days with one decimal", () => {
    expect(humanizeMs(1.5 * DAY)).toBe("1.5d");
  });

  it("rounds to the nearest second below the minute boundary", () => {
    expect(humanizeMs(1_400)).toBe("1s");
    expect(humanizeMs(1_600)).toBe("2s");
  });
});

// ── isCronJob (validated indirectly via the migrate/load path) ───────────────

describe("isCronJob (via loadCronJobs migration)", () => {
  function loadRaw(raw: unknown): void {
    existsSyncMock.mockReturnValueOnce(true).mockReturnValue(false);
    readFileSyncMock.mockReturnValueOnce(JSON.stringify(raw));
    loadCronJobs();
  }

  const base = {
    chatId: "c",
    type: "message" as const,
    content: "x",
    name: "n",
    enabled: true,
    createdAt: 1000,
    runCount: 0,
  };

  it("accepts a schedule-only job (legacy/cron mode)", () => {
    loadRaw({
      "valid-cron-only": {
        id: "valid-cron-only",
        schedule: "0 9 * * *",
        ...base,
      },
    });
    expect(getCronJob("valid-cron-only")).toBeDefined();
  });

  it("accepts an everyMs-only job (interval mode)", () => {
    loadRaw({
      "valid-interval-only": {
        id: "valid-interval-only",
        everyMs: 60_000,
        ...base,
      },
    });
    expect(getCronJob("valid-interval-only")).toBeDefined();
  });

  it("rejects a job with neither schedule nor everyMs", () => {
    loadRaw({
      "invalid-neither": { id: "invalid-neither", ...base },
    });
    expect(getCronJob("invalid-neither")).toBeUndefined();
  });

  it("rejects a job whose everyMs is 0 and has no schedule", () => {
    loadRaw({
      "invalid-zero-every": { id: "invalid-zero-every", everyMs: 0, ...base },
    });
    expect(getCronJob("invalid-zero-every")).toBeUndefined();
  });

  it("rejects a job carrying both schedule and everyMs (XOR enforced on load)", () => {
    // isCronJob enforces true XOR: a corrupt/hand-edited doc with both fields is
    // dropped on load rather than silently running as an interval.
    loadRaw({
      "both-fields": {
        id: "both-fields",
        schedule: "0 9 * * *",
        everyMs: 60_000,
        ...base,
      },
    });
    expect(getCronJob("both-fields")).toBeUndefined();
  });
});

// ── recordCronRun telemetry ──────────────────────────────────────────────────

describe("recordCronRun telemetry", () => {
  it("records an ok outcome with duration and no error", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    recordCronRun(id, { status: "ok", durationMs: 123 });
    const job = getCronJob(id)!;
    expect(job.lastStatus).toBe("ok");
    expect(job.lastDurationMs).toBe(123);
    expect(job.lastError).toBeUndefined();
    expect(job.runCount).toBe(1);
  });

  it("records an error outcome and surfaces the message", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    recordCronRun(id, { status: "error", error: "boom", durationMs: 7 });
    const job = getCronJob(id)!;
    expect(job.lastStatus).toBe("error");
    expect(job.lastError).toBe("boom");
    expect(job.lastDurationMs).toBe(7);
  });

  it("clears a stale lastError on the next successful run", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    recordCronRun(id, { status: "error", error: "first failure" });
    expect(getCronJob(id)!.lastError).toBe("first failure");

    recordCronRun(id, { status: "ok", durationMs: 5 });
    const job = getCronJob(id)!;
    expect(job.lastStatus).toBe("ok");
    expect(job.lastError).toBeUndefined();
  });

  it("bumps runCount on each recorded run", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id, runCount: 0 }));
    recordCronRun(id, { status: "ok" });
    recordCronRun(id, { status: "ok" });
    expect(getCronJob(id)!.runCount).toBe(2);
  });

  it("leaves telemetry untouched when no outcome is supplied", () => {
    const id = uniqueId();
    addCronJob(
      makeJob({
        id,
        lastStatus: "ok",
        lastError: undefined,
        lastDurationMs: 42,
      }),
    );
    recordCronRun(id); // no outcome
    const job = getCronJob(id)!;
    // runCount/lastRunAt move, but the prior telemetry stays as-is.
    expect(job.runCount).toBe(1);
    expect(job.lastStatus).toBe("ok");
    expect(job.lastDurationMs).toBe(42);
  });

  it("uses the `at` override for lastRunAt instead of now", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    const anchored = 1_700_000_000_000;
    recordCronRun(id, { status: "ok" }, anchored);
    expect(getCronJob(id)!.lastRunAt).toBe(anchored);
  });

  it("`at` override still bumps runCount (catch-up replays a real run)", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id, runCount: 3 }));
    recordCronRun(id, { status: "ok" }, 1_700_000_000_000);
    expect(getCronJob(id)!.runCount).toBe(4);
  });

  it("defaults lastRunAt to ~now when no `at` is given", () => {
    const id = uniqueId();
    addCronJob(makeJob({ id }));
    const before = Date.now();
    recordCronRun(id, { status: "ok" });
    const after = Date.now();
    const lastRun = getCronJob(id)!.lastRunAt!;
    expect(lastRun).toBeGreaterThanOrEqual(before);
    expect(lastRun).toBeLessThanOrEqual(after);
  });

  it("is a no-op for an unknown id", () => {
    expect(() =>
      recordCronRun("no-such-job-xyz", { status: "error", error: "x" }),
    ).not.toThrow();
  });

  it("backward-compat: a legacy bare-schedule job records runs unchanged", () => {
    // A job with none of the new fields behaves exactly as before: runCount
    // and lastRunAt advance, and no telemetry appears unless an outcome is given.
    const id = uniqueId();
    addCronJob({
      id,
      chatId: "legacy",
      schedule: "0 9 * * *",
      type: "message",
      content: "hi",
      name: "legacy",
      enabled: true,
      createdAt: 1000,
      runCount: 0,
    });
    recordCronRun(id);
    const job = getCronJob(id)!;
    expect(job.runCount).toBe(1);
    expect(job.lastRunAt).toBeDefined();
    expect(job.lastStatus).toBeUndefined();
    expect(job.lastError).toBeUndefined();
    expect(job.lastDurationMs).toBeUndefined();
  });
});
