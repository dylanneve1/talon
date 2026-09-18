/**
 * Phase 0 accounting (docs/ts-migration-plan.md): boot cost, idle resident
 * memory, and the daemon's own CPU per turn. Measurement only — these
 * tests assert that the numbers land under their documented names and
 * that nothing here can take a daemon down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordBootMetrics,
  startResourceSampler,
  stopResourceSampler,
} from "../core/daemon/resource-sampler.js";
import { bootPhase, resetBootPhases } from "../util/boot-timer.js";
import { getMetrics, resetMetrics } from "../storage/metrics.js";
import { Weaver } from "../core/weaver/index.js";
import type { ExecuteParams } from "../core/types.js";
import {
  buildDaemonDisplay,
  formatDaemonLine,
} from "../frontend/presentation/status-context.js";
import { stubBackend, stubResolveActiveModel } from "./helpers/stub-backend.js";

const SAMPLE_INTERVAL_MS = 60_000;

describe("boot metrics", () => {
  beforeEach(() => {
    resetMetrics();
    resetBootPhases();
  });
  afterEach(() => resetBootPhases());

  it("records the total, every phase, and the memory the boot ended on", async () => {
    await bootPhase("stores", () => 1);
    await bootPhase("backend + dispatcher", () => 2);

    recordBootMetrics(4210);

    const { histograms } = getMetrics();
    expect(histograms["boot.total_ms"]?.avg).toBe(4210);
    // Phase labels are prose; metric names are slugs of them.
    expect(histograms["boot.stores_ms"]?.count).toBe(1);
    expect(histograms["boot.backend_dispatcher_ms"]?.count).toBe(1);
    expect(histograms["boot.rss_mb"]?.count).toBe(1);
    expect(histograms["boot.heap_mb"]?.count).toBe(1);
    expect(histograms["boot.rss_mb"]!.avg).toBeGreaterThan(0);
  });

  it("defaults the total to process uptime, so the log and the metric agree", () => {
    recordBootMetrics();
    expect(getMetrics().histograms["boot.total_ms"]?.count).toBe(1);
  });
});

describe("resource sampler", () => {
  beforeEach(() => {
    resetMetrics();
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopResourceSampler();
    vi.useRealTimers();
  });

  it("records nothing until the first interval elapses", () => {
    startResourceSampler();
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS - 1);
    expect(getMetrics().histograms["rss.mb"]).toBeUndefined();
  });

  it("samples resident memory once a minute", () => {
    startResourceSampler();
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 3);

    const { histograms } = getMetrics();
    expect(histograms["rss.mb"]?.count).toBe(3);
    expect(histograms["heap_used.mb"]?.count).toBe(3);
    expect(histograms["external.mb"]?.count).toBe(3);
    // `getActiveResourcesInfo` exists on every runtime Talon supports, but
    // the sampler guards for its absence rather than assuming it.
    if (typeof process.getActiveResourcesInfo === "function") {
      expect(histograms["handles.count"]?.count).toBe(3);
    }
  });

  it("is idempotent — a second start does not double-sample", () => {
    startResourceSampler();
    startResourceSampler();
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    expect(getMetrics().histograms["rss.mb"]?.count).toBe(1);
  });

  it("stops on shutdown and survives a redundant stop", () => {
    startResourceSampler();
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    stopResourceSampler();
    stopResourceSampler();
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 5);
    expect(getMetrics().histograms["rss.mb"]?.count).toBe(1);
  });

  it("never throws when the runtime cannot report memory", () => {
    const spy = vi.spyOn(process, "memoryUsage").mockImplementation((() => {
      throw new Error("no /proc for you");
    }) as unknown as typeof process.memoryUsage);
    try {
      startResourceSampler();
      expect(() => vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)).not.toThrow();
      expect(getMetrics().histograms["rss.mb"]).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("per-turn CPU", () => {
  beforeEach(() => resetMetrics());

  function params(): ExecuteParams {
    return {
      chatId: "cpu-chat",
      numericChatId: 1,
      prompt: "hello",
      senderName: "User",
      isGroup: false,
      source: "message",
    };
  }

  it("records the daemon's own CPU over the same bracket as turn.stream_ms", async () => {
    const backend = stubBackend({
      query: vi.fn(async () => ({
        text: "hi",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      })),
    });
    const weaver = new Weaver({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
    });

    await weaver.runTurn(params());

    const cpu = getMetrics().histograms["turn.cpu_ms"];
    expect(cpu?.count).toBe(1);
    expect(cpu!.avg).toBeGreaterThanOrEqual(0);
    // The ratio Phase 0's kill criterion needs has a denominator.
    expect(getMetrics().histograms["turn.stream_ms"]?.count).toBe(1);
  });
});

describe("/status daemon line", () => {
  it("shows resident memory and the mean CPU a turn costs", () => {
    const line = formatDaemonLine(
      buildDaemonDisplay({
        rssBytes: 148 * 1024 * 1024,
        heapBytes: 108 * 1024 * 1024,
        cpuPerTurn: { count: 12, avg: 42 },
      }),
    );
    expect(line).toBe(
      "Daemon: rss 148 MB · heap 108 MB · cpu/turn avg 42 ms (n=12)",
    );
  });

  it("says nothing it cannot measure before the first turn", () => {
    const display = buildDaemonDisplay({
      rssBytes: 90 * 1024 * 1024,
      heapBytes: 60 * 1024 * 1024,
    });
    expect(display.cpuPerTurnMs).toBeUndefined();
    expect(formatDaemonLine(display)).toBe(
      "Daemon: rss 90 MB · heap 60 MB · cpu/turn —",
    );
  });

  it("treats an empty histogram as no samples, not as zero CPU", () => {
    const display = buildDaemonDisplay({
      rssBytes: 0,
      heapBytes: 0,
      cpuPerTurn: { count: 0, avg: 0 },
    });
    expect(display.cpuPerTurnMs).toBeUndefined();
    expect(display.rssMb).toBe(0);
  });
});
