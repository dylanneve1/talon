/**
 * Runtime-wiring tests for src/core/background/cron.ts.
 *
 * These exercise the parts of cron.ts that actually run jobs: run-now,
 * last-run telemetry, one-shot retirement, startup catch-up, and isolated
 * query execution via runJobOneShot.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../storage/cron-store.js";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  atomicWrite: vi.fn(),
  sendMessage: vi.fn(async (_chatId: number, _text: string) => {}),
  resolveChatModel: vi.fn(async (_chatId: string) => ({
    model: "chat-model",
    backendId: "chat-backend",
  })),
  getActiveCount: vi.fn(() => 0),
  runJobOneShot: vi.fn(async (_params: Record<string, unknown>) => ({
    status: "ran" as const,
  })),
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: Object.assign((...args: unknown[]) => mocks.atomicWrite(...args), {
    sync: mocks.atomicWrite,
  }),
}));

vi.mock("../util/cleanup-registry.js", () => ({
  registerCleanup: vi.fn(),
}));

vi.mock("../util/paths.js", () => ({
  files: { cron: "/mock/data/cron.json" },
  dirs: {},
}));

vi.mock("../storage/daily-log.js", () => ({
  appendDailyLog: vi.fn(),
  appendDailyLogResponse: vi.fn(),
}));

vi.mock("../core/engine/dispatcher.js", () => ({
  getActiveCount: mocks.getActiveCount,
}));

vi.mock("../core/background/job-oneshot.js", () => ({
  runJobOneShot: mocks.runJobOneShot,
}));

const { executeJob, initCron, runJobNow, runStartupCatchup } =
  await import("../core/background/cron.js");
const { addCronJob, getCronJob, getAllCronJobs, deleteCronJob } =
  await import("../storage/cron-store.js");
const { resetJobHealth } = await import("../core/background/job-health.js");

let seq = 0;
function uniqueId(): string {
  return `rt-cron-${++seq}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: uniqueId(),
    chatId: "123",
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

function seed(overrides: Partial<CronJob> = {}): CronJob {
  const job = makeJob(overrides);
  addCronJob(job);
  return job;
}

beforeEach(() => {
  for (const j of getAllCronJobs()) deleteCronJob(j.id);
  resetJobHealth();
  vi.clearAllMocks();
  mocks.getActiveCount.mockReturnValue(0);
  mocks.resolveChatModel.mockResolvedValue({
    model: "chat-model",
    backendId: "chat-backend",
  });
  mocks.runJobOneShot.mockResolvedValue({ status: "ran" });
  initCron({
    sendMessage: mocks.sendMessage,
    resolveChatModel: mocks.resolveChatModel,
  });
});

// ── isolated query execution ────────────────────────────────────────────────

describe("executeJob — isolated query runtime", () => {
  it("falls back to resolveChatModel when no provider/model override is stored", async () => {
    const result = await executeJob(
      makeJob({ type: "query", chatId: "42", content: "check status" }),
    );

    expect(result).toEqual({ status: "ran" });
    expect(mocks.resolveChatModel).toHaveBeenCalledWith("42");
    expect(mocks.runJobOneShot).toHaveBeenCalledOnce();
    expect(mocks.runJobOneShot.mock.calls[0]?.[0]).toMatchObject({
      chatId: "42",
      backendId: "chat-backend",
      model: "chat-model",
      label: "Test job",
      kind: "cron",
      timeoutMs: 10 * 60_000,
    });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("uses stored provider/model/instructions for query overrides", async () => {
    await executeJob(
      makeJob({
        type: "query",
        provider: "cheap-provider",
        model: "cheap-model",
        instructions: "Be terse.",
      }),
    );

    expect(mocks.resolveChatModel).not.toHaveBeenCalled();
    expect(mocks.runJobOneShot.mock.calls[0]?.[0]).toMatchObject({
      backendId: "cheap-provider",
      model: "cheap-model",
      instructions: "Be terse.",
    });
  });

  it("includes interval schedules in the isolated payload description", async () => {
    await executeJob(
      makeJob({
        type: "query",
        schedule: undefined,
        everyMs: 90 * 60_000,
        content: "summarize",
      }),
    );

    const params = mocks.runJobOneShot.mock.calls[0]?.[0] as {
      payload?: string;
    };
    expect(params.payload).toContain("schedule: every 1.5h");
    expect(params.payload).toContain("summarize");
  });

  it("throws clearly when the no-override path resolves no model", async () => {
    (mocks.resolveChatModel as any).mockResolvedValueOnce({
      model: null,
      backendId: "chat-backend",
    });

    await expect(executeJob(makeJob({ type: "query" }))).rejects.toThrow(
      /no model resolved for backend "chat-backend"/,
    );
    expect(mocks.runJobOneShot).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("skips and notifies the chat when runJobOneShot reports a stale target", async () => {
    (mocks.runJobOneShot as any).mockResolvedValueOnce({
      status: "skipped",
      reason: 'model "stale-model" is not selectable on provider "codex".',
    });

    const result = await executeJob(
      makeJob({
        chatId: "42",
        type: "query",
        provider: "codex",
        model: "stale-model",
        name: "Status check",
      }),
    );

    expect(result).toEqual({
      status: "skipped",
      reason: 'model "stale-model" is not selectable on provider "codex".',
    });
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      42,
      expect.stringContaining('Cron job "Status check" skipped: model'),
    );
  });
});

// ── runJobNow — routing ─────────────────────────────────────────────────────

describe("runJobNow — routing", () => {
  it("a message job calls sendMessage with the numeric chatId and content", async () => {
    const job = seed({ type: "message", chatId: "777", content: "ping" });

    const res = await runJobNow(job.id);

    expect(res.ok).toBe(true);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith(777, "ping");
    expect(mocks.runJobOneShot).not.toHaveBeenCalled();
  });

  it("a query job runs as an isolated one-shot, not a chat message", async () => {
    const job = seed({ type: "query", chatId: "42", content: "what is up" });

    const res = await runJobNow(job.id);

    expect(res.ok).toBe(true);
    expect(mocks.runJobOneShot).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    const params = mocks.runJobOneShot.mock.calls[0]?.[0] as {
      chatId?: string;
      payload?: string;
    };
    expect(params.chatId).toBe("42");
    expect(params.payload).toContain("what is up");
  });
});

// ── runJobNow — success telemetry ────────────────────────────────────────────

describe("runJobNow — success bookkeeping", () => {
  it("records lastStatus ok, a numeric duration, and bumps runCount", async () => {
    const job = seed({ type: "message", runCount: 2 });

    const res = await runJobNow(job.id);
    expect(res.ok).toBe(true);

    const after = getCronJob(job.id)!;
    expect(after.lastStatus).toBe("ok");
    expect(typeof after.lastDurationMs).toBe("number");
    expect(after.lastDurationMs!).toBeGreaterThanOrEqual(0);
    expect(after.runCount).toBe(3);
    expect(after.lastRunAt).toBeGreaterThan(0);
  });

  it("clears a previous lastError on a successful run", async () => {
    const job = seed({
      type: "message",
      lastStatus: "error",
      lastError: "stale failure",
    });

    await runJobNow(job.id);

    const after = getCronJob(job.id)!;
    expect(after.lastStatus).toBe("ok");
    expect(after.lastError).toBeUndefined();
  });
});

// ── runJobNow — failure telemetry ────────────────────────────────────────────

describe("runJobNow — failure bookkeeping", () => {
  it("a throwing query run records error telemetry and returns ok:false", async () => {
    mocks.runJobOneShot.mockRejectedValueOnce(new Error("boom from one-shot"));
    const job = seed({ type: "query", content: "explode" });

    const res = await runJobNow(job.id);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom from one-shot");

    const after = getCronJob(job.id)!;
    expect(after.lastStatus).toBe("error");
    expect(after.lastError).toBe("boom from one-shot");
    expect(typeof after.lastDurationMs).toBe("number");
  });

  it("a failure does not bump runCount", async () => {
    mocks.runJobOneShot.mockRejectedValueOnce(new Error("nope"));
    const job = seed({ type: "query", content: "x", runCount: 5 });

    await runJobNow(job.id);

    expect(getCronJob(job.id)!.runCount).toBe(5);
  });

  it("a message job whose sendMessage throws is reported as an error", async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error("send failed"));
    const job = seed({ type: "message", content: "hi" });

    const res = await runJobNow(job.id);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("send failed");
    expect(getCronJob(job.id)!.lastStatus).toBe("error");
  });
});

// ── runJobNow — guards ───────────────────────────────────────────────────────

describe("runJobNow — guards", () => {
  it("returns an error for a missing job id", async () => {
    const res = await runJobNow("does-not-exist-xyz");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
    expect(mocks.runJobOneShot).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("returns an error when the job is already running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mocks.runJobOneShot.mockImplementationOnce(async () => {
      await gate;
      return { status: "ran" };
    });

    const job = seed({ type: "query", content: "slow" });

    const first = runJobNow(job.id);
    await Promise.resolve();
    await Promise.resolve();

    const second = await runJobNow(job.id);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already running");

    release();
    expect((await first).ok).toBe(true);
  });
});

// ── runJobNow — one-shot retirement ──────────────────────────────────────────

describe("runJobNow — maxRuns retirement", () => {
  it("a maxRuns:1 job is disabled after a single run-now", async () => {
    const job = seed({ type: "message", maxRuns: 1, runCount: 0 });

    const res = await runJobNow(job.id);
    expect(res.ok).toBe(true);

    const after = getCronJob(job.id)!;
    expect(after.runCount).toBe(1);
    expect(after.enabled).toBe(false);
  });

  it("a maxRuns:3 job stays enabled until the cap is reached", async () => {
    const job = seed({ type: "message", maxRuns: 3, runCount: 0 });

    await runJobNow(job.id);
    expect(getCronJob(job.id)!.enabled).toBe(true);
    await runJobNow(job.id);
    expect(getCronJob(job.id)!.enabled).toBe(true);
    await runJobNow(job.id);

    expect(getCronJob(job.id)!.runCount).toBe(3);
    expect(getCronJob(job.id)!.enabled).toBe(false);
  });

  it("a failed run does not retire a one-shot job", async () => {
    mocks.runJobOneShot.mockRejectedValueOnce(new Error("fail"));
    const job = seed({ type: "query", content: "x", maxRuns: 1, runCount: 0 });

    await runJobNow(job.id);

    const after = getCronJob(job.id)!;
    expect(after.runCount).toBe(0);
    expect(after.enabled).toBe(true);
  });
});

const MINUTE = 60_000;

// ── runStartupCatchup — policy honoring ──────────────────────────────────────

describe("runStartupCatchup — policies", () => {
  it("skip policy never replays, even with many missed runs", async () => {
    seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 10 * MINUTE,
      catchup: "skip",
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.runJobOneShot).not.toHaveBeenCalled();
  });

  it("a job with no catchup field defaults to skip", async () => {
    seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 8 * MINUTE,
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("once with N missed runs replays exactly one run", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 7 * MINUTE,
      catchup: "once",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(getCronJob(job.id)!.runCount).toBe(1);
  });

  it("all replays min(missed, CATCHUP_MAX=5) when missed exceeds the cap", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 50 * MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(5);
    expect(getCronJob(job.id)!.runCount).toBe(5);
  });

  it("all replays exactly the missed count when below the cap", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 3 * MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(3);
    expect(getCronJob(job.id)!.runCount).toBe(3);
  });

  it("all replays nothing when no intervals have elapsed", async () => {
    seed({
      schedule: undefined,
      everyMs: 10 * MINUTE,
      lastRunAt: Date.now() - 1000,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("a disabled job is never caught up", async () => {
    seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 9 * MINUTE,
      catchup: "all",
      enabled: false,
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});

// ── runStartupCatchup — lifecycle bounds ─────────────────────────────────────

describe("runStartupCatchup — lifecycle bounds", () => {
  it("a job whose endAt has passed is disabled and skipped", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 9 * MINUTE,
      endAt: Date.now() - MINUTE,
      catchup: "all",
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(getCronJob(job.id)!.enabled).toBe(false);
  });

  it("a job whose startAt is still in the future is skipped", async () => {
    seed({
      schedule: undefined,
      everyMs: MINUTE,
      startAt: Date.now() + 60 * MINUTE,
      catchup: "all",
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("maxRuns stops replay mid-way", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 5 * MINUTE,
      catchup: "all",
      maxRuns: 2,
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    const after = getCronJob(job.id)!;
    expect(after.runCount).toBe(2);
    expect(after.enabled).toBe(false);
  });

  it("maxRuns already consumed gets one replay then disables", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 5 * MINUTE,
      catchup: "all",
      maxRuns: 3,
      runCount: 3,
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(getCronJob(job.id)!.enabled).toBe(false);
  });
});

// ── runStartupCatchup — interval vs cron missed-run counting ─────────────────

describe("runStartupCatchup — interval vs cron", () => {
  it("interval jobs compute missed runs from everyMs and a stale lastRunAt", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 4 * MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(4);
    expect(getCronJob(job.id)!.runCount).toBe(4);
  });

  it("cron jobs compute missed runs by walking fire times since the anchor", async () => {
    const job = seed({
      schedule: "* * * * *",
      lastRunAt: Date.now() - 10 * MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage.mock.calls.length).toBeGreaterThan(0);
    expect(mocks.sendMessage.mock.calls.length).toBeLessThanOrEqual(5);
    expect(getCronJob(job.id)!.runCount).toBe(
      mocks.sendMessage.mock.calls.length,
    );
  });

  it("a cron once job with missed fire times replays exactly one", async () => {
    const job = seed({
      schedule: "* * * * *",
      lastRunAt: Date.now() - 10 * MINUTE,
      catchup: "once",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(getCronJob(job.id)!.runCount).toBe(1);
  });

  it("a cron job with no due fire times since its last run replays nothing", async () => {
    seed({
      schedule: "0 9 * * *",
      lastRunAt: Date.now() - MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("an interval query catch-up routes through isolated one-shot", async () => {
    const job = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 2 * MINUTE,
      catchup: "all",
      type: "query",
      content: "catch me up",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(mocks.runJobOneShot).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(getCronJob(job.id)!.runCount).toBe(2);
  });
});

// ── runStartupCatchup — multi-job + guards ───────────────────────────────────

describe("runStartupCatchup — fleet behavior", () => {
  it("processes each job by its own policy in one pass", async () => {
    const skip = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 6 * MINUTE,
      catchup: "skip",
      type: "message",
    });
    const once = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 6 * MINUTE,
      catchup: "once",
      type: "message",
      runCount: 0,
    });
    const all = seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 6 * MINUTE,
      catchup: "all",
      type: "message",
      runCount: 0,
    });

    await runStartupCatchup();

    expect(getCronJob(skip.id)!.runCount).toBe(0);
    expect(getCronJob(once.id)!.runCount).toBe(1);
    expect(getCronJob(all.id)!.runCount).toBe(5);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(6);
  });

  it("stops catch-up when active work is high", async () => {
    mocks.getActiveCount.mockReturnValue(11);
    seed({
      schedule: undefined,
      everyMs: MINUTE,
      lastRunAt: Date.now() - 6 * MINUTE,
      catchup: "all",
      type: "message",
    });

    await runStartupCatchup();

    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
