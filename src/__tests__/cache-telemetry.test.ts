/**
 * Tests for prompt-cache telemetry.
 *
 * The behaviour under test exists because the aggregate `cache=NN%` on the
 * accounting line is compatible with every turn re-writing the whole prefix:
 * an agentic turn makes many model requests and all but the first read the
 * prefix the first one paid for. Measured on the live deployment, one session
 * read 242,847 cached tokens against 30,326 written — an 8:1 ratio that is
 * entirely within-turn and says nothing about cross-turn reuse.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as logModule from "../util/log.js";
import {
  CACHE_LOOKBACK_BLOCKS,
  cacheMinimumTokens,
  crossTurnVerdict,
  estimateTurnBlocks,
  exceedsLookbackWindow,
  formatTurnCache,
  noteToolFingerprint,
  resetToolFingerprints,
  toolFingerprint,
  turnCacheStats,
  warnIfBelowCacheMinimum,
  type CacheIteration,
} from "../backend/shared/cache-telemetry.js";

const iter = (read: number, write: number): CacheIteration => ({
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
});

/** Spy on the real warn seam — `logWarn` goes through pino, not console. */
function spyWarn(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(logModule, "logWarn").mockImplementation(() => {});
}

describe("turnCacheStats", () => {
  it("returns undefined when the provider reported no iterations", () => {
    expect(turnCacheStats(undefined)).toBeUndefined();
    expect(turnCacheStats([])).toBeUndefined();
  });

  it("separates the first request from the turn totals", () => {
    // The shape of a real agentic turn: pay once, then read repeatedly.
    const stats = turnCacheStats([
      iter(0, 22_000),
      iter(22_000, 0),
      iter(22_000, 0),
    ])!;
    expect(stats.modelRequests).toBe(3);
    expect(stats.firstRead).toBe(0);
    expect(stats.firstWrite).toBe(22_000);
    expect(stats.totalRead).toBe(44_000);
    expect(stats.totalWrite).toBe(22_000);
  });

  it("treats absent token fields as zero", () => {
    const stats = turnCacheStats([{}, { cache_read_input_tokens: 5 }])!;
    expect(stats.firstRead).toBe(0);
    expect(stats.totalRead).toBe(5);
    expect(stats.totalWrite).toBe(0);
  });
});

describe("crossTurnVerdict", () => {
  it("reports a miss when the turn paid to re-write the prefix", () => {
    // A 2:1 aggregate read:write ratio still means the previous turn's
    // prefix was gone — this is the case a short cache TTL produces.
    const stats = turnCacheStats([iter(0, 20_000), iter(40_000, 0)])!;
    expect(crossTurnVerdict(stats)).toBe("miss");
  });

  it("reports a hit when the first request read a cache", () => {
    const stats = turnCacheStats([iter(20_000, 0), iter(20_000, 0)])!;
    expect(crossTurnVerdict(stats)).toBe("hit");
  });

  it("reports none when nothing was cached either way", () => {
    // Below the model's cacheable floor, or a provider that doesn't cache.
    const stats = turnCacheStats([iter(0, 0)])!;
    expect(crossTurnVerdict(stats)).toBe("none");
  });
});

describe("formatTurnCache", () => {
  it("emits a parseable space-delimited suffix", () => {
    const stats = turnCacheStats([iter(0, 10_000), iter(80_000, 0)])!;
    expect(formatTurnCache(stats)).toBe("xturn=miss reqs=2 rw=8.0");
  });

  it("omits the ratio when nothing was written", () => {
    const stats = turnCacheStats([iter(500, 0)])!;
    expect(formatTurnCache(stats)).toBe("xturn=hit reqs=1");
  });
});

describe("lookback window", () => {
  it("counts two blocks per tool call plus surrounding text", () => {
    expect(estimateTurnBlocks(0)).toBe(1);
    expect(estimateTurnBlocks(3)).toBe(7);
  });

  it("flags a turn that plausibly outran the lookback window", () => {
    expect(exceedsLookbackWindow(9)).toBe(false); // 19 blocks
    expect(exceedsLookbackWindow(10)).toBe(true); // 21 blocks
    expect(estimateTurnBlocks(10)).toBeGreaterThan(CACHE_LOOKBACK_BLOCKS);
  });

  it("treats a negative tool count as zero", () => {
    expect(estimateTurnBlocks(-5)).toBe(1);
  });
});

describe("cacheMinimumTokens", () => {
  it("knows the floor is not monotonic across generations", () => {
    // The whole reason for a table rather than a version comparison.
    expect(cacheMinimumTokens("claude-opus-5")).toBe(512);
    expect(cacheMinimumTokens("claude-opus-4-8")).toBe(1024);
    expect(cacheMinimumTokens("claude-opus-4-7")).toBe(2048);
    expect(cacheMinimumTokens("claude-opus-4-6")).toBe(4096);
    expect(cacheMinimumTokens("claude-haiku-4-5")).toBe(4096);
  });

  it("prefers the longest matching key", () => {
    // "sonnet-4-6" must not be resolved by a bare "sonnet" entry.
    expect(cacheMinimumTokens("claude-sonnet-4-6")).toBe(1024);
    expect(cacheMinimumTokens("claude-haiku-4-5")).toBe(4096);
  });

  it("resolves SDK model strings with suffixes", () => {
    expect(cacheMinimumTokens("sonnet-5[1m]")).toBe(1024);
    expect(cacheMinimumTokens("haiku")).toBe(4096);
  });

  it("returns undefined for ambiguous aliases rather than guessing", () => {
    // A warning that fires on the wrong model teaches people to ignore it.
    expect(cacheMinimumTokens("default")).toBeUndefined();
    expect(cacheMinimumTokens("opus")).toBeUndefined();
    expect(cacheMinimumTokens("sonnet")).toBeUndefined();
    expect(cacheMinimumTokens("gpt-5")).toBeUndefined();
  });
});

describe("warnIfBelowCacheMinimum", () => {
  it("warns when a prompt is under the model's floor", () => {
    const warn = spyWarn();
    warnIfBelowCacheMinimum("dream", "claude-haiku-4-5", "x".repeat(400));
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[1])).toContain("cacheable minimum");
    warn.mockRestore();
  });

  it("stays quiet when the prompt clears the floor", () => {
    const warn = spyWarn();
    warnIfBelowCacheMinimum("dream", "claude-haiku-4-5", "x".repeat(40_000));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stays quiet when the model's floor is unknown", () => {
    const warn = spyWarn();
    warnIfBelowCacheMinimum("dream", "default", "x");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("tool fingerprint", () => {
  beforeEach(() => {
    resetToolFingerprints();
  });

  it("is order-insensitive and deduped", () => {
    expect(toolFingerprint(["Bash", "Read"], ["talon"])).toEqual(
      toolFingerprint(["Read", "Bash", "Read"], ["talon"]),
    );
  });

  it("namespaces MCP servers so they can't collide with built-ins", () => {
    expect(toolFingerprint([], ["Bash"])).toEqual(["mcp:Bash"]);
  });

  it("does not warn on the first turn of a chat", () => {
    const warn = spyWarn();
    const changed = noteToolFingerprint(
      "chat-1",
      toolFingerprint(["Bash"], []),
    );
    expect(changed).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not warn when the tool set is stable", () => {
    const warn = spyWarn();
    noteToolFingerprint("chat-1", toolFingerprint(["Bash", "Read"], ["talon"]));
    const changed = noteToolFingerprint(
      "chat-1",
      toolFingerprint(["Read", "Bash"], ["talon"]),
    );
    expect(changed).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns and names the delta when a plugin server appears", () => {
    const warn = spyWarn();
    noteToolFingerprint("chat-1", toolFingerprint(["Bash"], ["talon"]));
    const changed = noteToolFingerprint(
      "chat-1",
      toolFingerprint(["Bash"], ["talon", "mempalace"]),
    );
    expect(changed).toBe(true);
    const message = String(warn.mock.calls[0]?.[1]);
    expect(message).toContain("tool set changed mid-session");
    expect(message).toContain("mcp:mempalace");
    warn.mockRestore();
  });

  it("names removals too", () => {
    const warn = spyWarn();
    noteToolFingerprint("chat-1", toolFingerprint(["Bash", "Read"], []));
    noteToolFingerprint("chat-1", toolFingerprint(["Bash"], []));
    expect(String(warn.mock.calls[0]?.[1])).toContain("-Read");
    warn.mockRestore();
  });

  it("tracks chats independently", () => {
    const warn = spyWarn();
    noteToolFingerprint("chat-1", toolFingerprint(["Bash"], []));
    const changed = noteToolFingerprint(
      "chat-2",
      toolFingerprint(["Read"], []),
    );
    expect(changed).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
