/**
 * Reasoning-effort resolution for background runs
 * (core/background/effort.ts) plus the canonical level ladder
 * (core/models/reasoning-levels.ts).
 *
 * The division under test: core decides whether a configured level is
 * AVAILABLE on the run's model (via the backend's catalog capability),
 * backends decide how to EXPRESS it. So these cases are all about what
 * core passes on versus drops, and they deliberately never assert on
 * provider-specific option names.
 */

import { describe, it, expect, vi } from "vitest";
import { resolveBackgroundEffort } from "../core/background/effort.js";
import {
  REASONING_LEVEL_ORDER,
  normalizeReasoningLevels,
} from "../core/models/reasoning-levels.js";
import type { ReasoningEffortLevel, UnifiedModelInfo } from "../core/types.js";
import { stubBackend } from "./helpers/stub-backend.js";

/** Backend whose catalog reports `levels` for every model id. */
function backendWithLevels(
  levels: ReasoningEffortLevel[] | undefined,
): ReturnType<typeof stubBackend> {
  return stubBackend({
    getModelInfo: async (id: string): Promise<UnifiedModelInfo> => ({
      id,
      displayName: id,
      provider: "test",
      providerName: "Test",
      selectable: true,
      ...(levels ? { supportedReasoningLevels: levels } : {}),
    }),
  });
}

describe("resolveBackgroundEffort", () => {
  it("returns nothing when no effort is configured", async () => {
    const result = await resolveBackgroundEffort({
      requested: undefined,
      model: "m",
      backend: backendWithLevels(["low", "high"]),
    });
    expect(result).toEqual({});
  });

  it("passes a level the model advertises", async () => {
    const result = await resolveBackgroundEffort({
      requested: "high",
      model: "m",
      backend: backendWithLevels(["low", "medium", "high"]),
    });
    expect(result).toEqual({ effort: "high" });
  });

  it("drops a level the model does not advertise, with a reason", async () => {
    const result = await resolveBackgroundEffort({
      requested: "xhigh",
      model: "claude-haiku-4-5",
      backend: backendWithLevels(["low", "medium", "high"]),
    });
    expect(result.effort).toBeUndefined();
    expect(result.dropped).toContain("xhigh");
    expect(result.dropped).toContain("claude-haiku-4-5");
    // The reason names the alternatives so the fix is obvious from the log.
    expect(result.dropped).toContain("low, medium, high");
  });

  // The next three are all "we can't know" — absent metadata must not be
  // read as "unsupported", or a catalog gap would silently downgrade every
  // background run to the model default.
  it("passes the level through when the model reports no level metadata", async () => {
    const result = await resolveBackgroundEffort({
      requested: "high",
      model: "m",
      backend: backendWithLevels(undefined),
    });
    expect(result).toEqual({ effort: "high" });
  });

  it("passes the level through when the backend has no catalog capability", async () => {
    const result = await resolveBackgroundEffort({
      requested: "high",
      model: "m",
      backend: stubBackend({ runOneShotAgent: async () => undefined }),
    });
    expect(result).toEqual({ effort: "high" });
  });

  it("passes the level through when the catalog throws", async () => {
    const result = await resolveBackgroundEffort({
      requested: "high",
      model: "m",
      backend: stubBackend({
        getModelInfo: vi.fn(async () => {
          throw new Error("catalog down");
        }),
      }),
    });
    expect(result).toEqual({ effort: "high" });
  });

  it("passes the level through when there is no backend at all", async () => {
    const result = await resolveBackgroundEffort({
      requested: "low",
      model: "m",
      backend: null,
    });
    expect(result).toEqual({ effort: "low" });
  });
});

describe("REASONING_LEVEL_ORDER", () => {
  it("is an ascending ladder ending xhigh → max", () => {
    expect(REASONING_LEVEL_ORDER).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("sorts a model's advertised levels into ladder order (picker rendering)", () => {
    // Catalogs report levels in whatever order the provider lists them;
    // pickers render whatever this returns.
    expect(normalizeReasoningLevels(["max", "low", "xhigh", "high"])).toEqual([
      "low",
      "high",
      "xhigh",
      "max",
    ]);
  });
});
