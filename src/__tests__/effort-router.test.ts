/**
 * Adaptive effort router — classification heuristics, level snapping,
 * routing scope rules, and the turn-override lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const mockGetChatSettings = vi.fn(
  (): { effort?: string } => ({}),
);
vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: mockGetChatSettings,
}));

import type { ModelRef } from "../core/agent-runtime/model-ref.js";
import type { ReasoningEffortLevel } from "../core/types.js";

const {
  classifyEffortTier,
  clearTurnEffortOverride,
  getTurnEffortOverride,
  initEffortRouter,
  routeEffortForTurn,
  setTurnEffortOverride,
  snapToSupportedLevel,
} = await import("../core/models/effort-router.js");

function makeRef(
  effortLevels?: readonly ReasoningEffortLevel[],
): ModelRef {
  return {
    backend: "claude",
    id: "test-model",
    displayName: "Test Model",
    source: "discovered",
    cacheSupport: "none",
    selectable: true,
    effortLevels,
  } as ModelRef;
}

const ALL_LEVELS: ReasoningEffortLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
];

beforeEach(() => {
  initEffortRouter({ enabled: true });
  mockGetChatSettings.mockReturnValue({});
  clearTurnEffortOverride("chat-1");
});

describe("classifyEffortTier", () => {
  it("buckets short greetings and acks as light", () => {
    expect(classifyEffortTier("hey")).toBe("light");
    expect(classifyEffortTier("thanks!")).toBe("light");
    expect(classifyEffortTier("lol")).toBe("light");
    expect(classifyEffortTier("ok")).toBe("light");
    expect(classifyEffortTier("👍")).toBe("light");
  });

  it("does not treat a long message starting with 'thanks' as light", () => {
    const text =
      "thanks — but now I need you to figure out why the deploy fails " +
      "when the cache is warm and passes when it's cold";
    expect(classifyEffortTier(text)).not.toBe("light");
  });

  it("buckets reasoning-keyword messages as heavy", () => {
    expect(classifyEffortTier("can you debug this stack trace for me")).toBe(
      "heavy",
    );
    expect(
      classifyEffortTier("compare the trade-offs between sqlite and postgres"),
    ).toBe("heavy");
    expect(classifyEffortTier("walk me through it step by step")).toBe(
      "heavy",
    );
  });

  it("buckets code blocks and very long messages as heavy", () => {
    expect(classifyEffortTier("```\nconst x = 1;\n```")).toBe("heavy");
    expect(classifyEffortTier("a".repeat(700))).toBe("heavy");
  });

  it("buckets many-question messages as heavy", () => {
    expect(
      classifyEffortTier("what is X? how does Y work? when did Z change?"),
    ).toBe("heavy");
  });

  it("defaults the middle ground to standard", () => {
    expect(classifyEffortTier("what time is the meeting tomorrow?")).toBe(
      "standard",
    );
    expect(classifyEffortTier("send the photo from yesterday to the group")).toBe(
      "standard",
    );
  });
});

describe("snapToSupportedLevel", () => {
  it("returns the target when supported", () => {
    expect(snapToSupportedLevel("medium", ALL_LEVELS)).toBe("medium");
  });

  it("prefers the nearest lower level on a miss", () => {
    expect(snapToSupportedLevel("medium", ["low", "high"])).toBe("low");
  });

  it("snaps upward when nothing lower exists", () => {
    expect(snapToSupportedLevel("low", ["medium", "high"])).toBe("medium");
  });

  it("returns undefined for an empty surface", () => {
    expect(snapToSupportedLevel("medium", [])).toBeUndefined();
  });
});

describe("routeEffortForTurn", () => {
  it("routes tiers onto the model's levels", () => {
    expect(routeEffortForTurn("chat-1", "thanks!", makeRef(ALL_LEVELS))).toBe(
      "low",
    );
    expect(
      routeEffortForTurn("chat-1", "what's for dinner?", makeRef(ALL_LEVELS)),
    ).toBe("medium");
    expect(
      routeEffortForTurn(
        "chat-1",
        "debug why the importer crashes",
        makeRef(ALL_LEVELS),
      ),
    ).toBe("high");
  });

  it("does nothing when disabled", () => {
    initEffortRouter({ enabled: false });
    expect(
      routeEffortForTurn("chat-1", "debug this", makeRef(ALL_LEVELS)),
    ).toBeUndefined();
  });

  it("defers to an explicit per-chat effort pick", () => {
    mockGetChatSettings.mockReturnValue({ effort: "max" });
    expect(
      routeEffortForTurn("chat-1", "debug this", makeRef(ALL_LEVELS)),
    ).toBeUndefined();
  });

  it("skips models without an effort surface", () => {
    expect(
      routeEffortForTurn("chat-1", "debug this", makeRef(undefined)),
    ).toBeUndefined();
    expect(
      routeEffortForTurn("chat-1", "debug this", makeRef([])),
    ).toBeUndefined();
    expect(routeEffortForTurn("chat-1", "debug this", null)).toBeUndefined();
  });
});

describe("turn override lifecycle", () => {
  it("set / get / clear round-trip", () => {
    expect(getTurnEffortOverride("chat-1")).toBeUndefined();
    setTurnEffortOverride("chat-1", "high");
    expect(getTurnEffortOverride("chat-1")).toBe("high");
    expect(getTurnEffortOverride("chat-2")).toBeUndefined();
    clearTurnEffortOverride("chat-1");
    expect(getTurnEffortOverride("chat-1")).toBeUndefined();
  });
});
