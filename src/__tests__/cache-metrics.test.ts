/**
 * Tests for the prompt-cache rollups (docs/cache-economics.md, PR A).
 *
 * The point of these numbers is that nothing else answers the question they
 * answer: the aggregate `cache=NN%` folds every request of an agentic turn
 * together, and all but the first read the prefix the first one paid for. So
 * the counters here are keyed on the turn's FIRST request, split out again
 * for a session's first turn (the only turn whose hit can only have come from
 * ANOTHER chat warming an identical prefix), and joined by the compaction
 * boundaries that throw a cached transcript away.
 *
 * Everything under test is measurement: no prompt bytes, no turn behaviour.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as logModule from "../util/log.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  recordCompactBoundary,
  reportToolFingerprint,
  rollUpTurnCache,
} from "../backend/runtime/cache/cache-metrics.js";
import {
  resetToolFingerprints,
  turnCacheStats,
  type TurnCacheStats,
} from "../backend/runtime/cache/cache-telemetry.js";
import {
  isCompactBoundary,
  processCompactBoundary,
} from "../backend/claude-sdk/stream.js";
import {
  getCacheVerdict,
  getMetrics,
  resetMetrics,
} from "../storage/metrics.js";
import {
  getSessionInfo,
  loadSessions,
  recordUsage,
} from "../storage/sessions.js";
import {
  buildCacheTempDisplay,
  formatCacheTempLine,
} from "../frontend/presentation/status-context.js";

/** Per-worker DBs are shared across a file — keep every chat id distinct. */
let seq = 0;
const chat = (name: string): string => `cache-metrics-${name}-${++seq}`;

/** A turn whose first request read `read` and wrote `write` cache tokens. */
function stats(read: number, write: number): TurnCacheStats {
  return turnCacheStats([
    { cache_read_input_tokens: read, cache_creation_input_tokens: write },
  ])!;
}

beforeEach(() => {
  resetMetrics();
  resetToolFingerprints();
  vi.restoreAllMocks();
});

describe("rollUpTurnCache", () => {
  it("maps the cross-turn verdict onto cache.first_request.<verdict>", () => {
    rollUpTurnCache(chat("hit"), stats(1200, 0), 4);
    rollUpTurnCache(chat("miss"), stats(0, 900), 4);
    rollUpTurnCache(chat("none"), stats(0, 0), 4);

    const { counters } = getMetrics();
    expect(counters["cache.first_request.hit"]).toBe(1);
    expect(counters["cache.first_request.miss"]).toBe(1);
    expect(counters["cache.first_request.none"]).toBe(1);
  });

  it("records the first request's read and write sizes", () => {
    rollUpTurnCache(chat("sizes"), stats(1200, 0), 2);
    rollUpTurnCache(chat("sizes"), stats(0, 800), 3);

    const { histograms } = getMetrics();
    // Recorded on every turn, zeros included, so the average is "tokens per
    // turn" rather than an average over the interesting turns only.
    expect(histograms["cache.first_request.read_tokens"]).toMatchObject({
      count: 2,
      max: 1200,
      min: 0,
    });
    expect(histograms["cache.first_request.write_tokens"]).toMatchObject({
      count: 2,
      max: 800,
      min: 0,
    });
  });

  it("counts cache.session_start only on a session's first turn", () => {
    // turnsIncludingThis === 1 — `incrementTurns` has already run, so this
    // was the chat's very first turn.
    rollUpTurnCache(chat("start"), stats(4000, 0), 1);
    rollUpTurnCache(chat("later"), stats(4000, 0), 2);
    rollUpTurnCache(chat("later"), stats(4000, 0), 17);

    const { counters } = getMetrics();
    expect(counters["cache.session_start.hit"]).toBe(1);
    expect(counters["cache.session_start.miss"]).toBeUndefined();
    expect(counters["cache.first_request.hit"]).toBe(3);
  });

  it("splits a fresh session's miss out from the hits", () => {
    rollUpTurnCache(chat("cold-start"), stats(0, 30_000), 1);

    const { counters } = getMetrics();
    expect(counters["cache.session_start.miss"]).toBe(1);
    expect(counters["cache.session_start.hit"]).toBeUndefined();
  });

  it("remembers the chat's latest verdict for /status", () => {
    const id = chat("verdict");
    expect(getCacheVerdict(id)).toBeUndefined();
    rollUpTurnCache(id, stats(0, 900), 1);
    expect(getCacheVerdict(id)).toBe("miss");
    rollUpTurnCache(id, stats(900, 0), 2);
    expect(getCacheVerdict(id)).toBe("hit");
  });
});

describe("reportToolFingerprint", () => {
  it("logs the fingerprint once per chat and counts changes", () => {
    const info = vi.spyOn(logModule, "log").mockImplementation(() => {});
    vi.spyOn(logModule, "logWarn").mockImplementation(() => {});
    const id = chat("fingerprint");

    reportToolFingerprint(id, ["Bash", "Read", "mcp:telegram-tools"]);
    const firstLine = info.mock.calls.map((c) => String(c[1])).join("\n");
    expect(firstLine).toMatch(
      new RegExp(`\\[${id}\\] tool fingerprint [0-9a-f]{12} \\(3 tools\\)`),
    );
    expect(getMetrics().counters["cache.tool_fingerprint.changed"]).toBe(
      undefined,
    );

    info.mockClear();
    // Same set again: no new line (the chat is already fingerprinted), no
    // change counted.
    reportToolFingerprint(id, ["Bash", "Read", "mcp:telegram-tools"]);
    expect(info).not.toHaveBeenCalled();
    expect(getMetrics().counters["cache.tool_fingerprint.changed"]).toBe(
      undefined,
    );

    // A tool appearing mid-session invalidates the system prompt and every
    // cached message after it — the expensive event this counter exists for.
    reportToolFingerprint(id, ["Bash", "Read", "mcp:plugin-x"]);
    expect(getMetrics().counters["cache.tool_fingerprint.changed"]).toBe(1);
  });
});

describe("compaction boundaries", () => {
  const boundary = (
    trigger: "manual" | "auto",
    pre: number,
    post?: number,
  ): SDKMessage =>
    ({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger,
        pre_tokens: pre,
        ...(post === undefined ? {} : { post_tokens: post }),
      },
    }) as unknown as SDKMessage;

  it("recognises the boundary without swallowing the init message", () => {
    expect(isCompactBoundary(boundary("auto", 10))).toBe(true);
    expect(
      isCompactBoundary({
        type: "system",
        subtype: "init",
      } as unknown as SDKMessage),
    ).toBe(false);
  });

  it("counts a manual compaction with both token sizes", () => {
    vi.spyOn(logModule, "log").mockImplementation(() => {});
    processCompactBoundary(
      boundary("manual", 120_000, 30_000) as never,
      chat("compact-manual"),
    );

    const { counters, histograms } = getMetrics();
    expect(counters["session.compacted.manual"]).toBe(1);
    expect(histograms["session.compact.pre_tokens"]).toMatchObject({
      count: 1,
      max: 120_000,
    });
    expect(histograms["session.compact.post_tokens"]).toMatchObject({
      count: 1,
      max: 30_000,
    });
  });

  it("counts an auto compaction and skips the post histogram when absent", () => {
    const info = vi.spyOn(logModule, "log").mockImplementation(() => {});
    recordCompactBoundary(chat("compact-auto"), {
      trigger: "auto",
      pre_tokens: 90_000,
    });

    const { counters, histograms } = getMetrics();
    expect(counters["session.compacted.auto"]).toBe(1);
    expect(counters["session.compacted.manual"]).toBeUndefined();
    expect(histograms["session.compact.pre_tokens"]).toMatchObject({
      count: 1,
    });
    expect(histograms["session.compact.post_tokens"]).toBeUndefined();
    expect(info.mock.calls.map((c) => String(c[1])).join("\n")).toContain(
      "context compacted (auto)",
    );
  });
});

describe("lastTurnEndedAt", () => {
  it("is set when a turn's usage is recorded, and survives a reload", () => {
    const id = chat("ended-at");
    expect(getSessionInfo(id).lastTurnEndedAt).toBeUndefined();

    const before = Date.now();
    recordUsage(id, {
      inputTokens: 10,
      outputTokens: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const ended = getSessionInfo(id).lastTurnEndedAt;
    expect(ended).toBeGreaterThanOrEqual(before);
    expect(ended).toBeLessThanOrEqual(Date.now());

    // Re-prime the cache from SQLite: the column, not just the in-memory
    // field, is what PR C's "is this chat cold?" check will read.
    loadSessions();
    expect(getSessionInfo(id).lastTurnEndedAt).toBe(ended);
  });
});

describe("the /status cache line", () => {
  it("renders the verdict and the idle gap", () => {
    const now = Date.UTC(2026, 8, 18, 12, 0, 0);
    const temp = buildCacheTempDisplay({
      verdict: "hit",
      lastTurnEndedAt: now - 185_000,
      now,
    });
    expect(temp).toEqual({ verdict: "hit", idle: "3m 5s" });
    expect(formatCacheTempLine(temp!)).toBe(
      "Cache: hit last turn · idle 3m 5s",
    );
  });

  it("still renders when no verdict was recorded in this process", () => {
    const now = Date.UTC(2026, 8, 18, 12, 0, 0);
    const temp = buildCacheTempDisplay({
      lastTurnEndedAt: now - 3_600_000,
      now,
    });
    expect(formatCacheTempLine(temp!)).toBe(
      "Cache: unknown last turn · idle 1h 0m",
    );
  });

  it("is omitted entirely for a chat that has never completed a turn", () => {
    expect(buildCacheTempDisplay({})).toBeNull();
    expect(buildCacheTempDisplay({ lastTurnEndedAt: 0 })).toBeNull();
  });

  it("shows a verdict even before a turn end is on record", () => {
    // Older session rows pre-date the column; the verdict alone is still
    // worth showing rather than dropping the line.
    expect(buildCacheTempDisplay({ verdict: "miss" })).toEqual({
      verdict: "miss",
      idle: "—",
    });
  });
});
