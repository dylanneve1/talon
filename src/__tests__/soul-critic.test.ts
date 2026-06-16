/**
 * Tests for the mechanical Critic. The classifiers must flag Talon's documented
 * failure modes and stay quiet on clean, direct prose.
 */

import { describe, expect, it } from "vitest";
import {
  critique,
  extractFeatures,
  isFlagged,
  DEFAULT_THRESHOLDS,
} from "../core/soul/critic.js";

const clean = "Branch is live. Six commits, 61 tests green. Reflex layer next.";

describe("extractFeatures", () => {
  it("counts hedges and emoji density", () => {
    const f = extractFeatures("I think maybe this is sort of fine 🔥🔥");
    expect(f.hedgeRate).toBeGreaterThan(0);
    expect(f.emojiDensity).toBeGreaterThan(0);
  });
});

describe("critique", () => {
  it("stays quiet on clean, direct prose", () => {
    expect(isFlagged(critique(clean))).toBe(false);
  });

  it("flags wall-of-text", () => {
    const wall = "word ".repeat(2000);
    const c = critique(wall).find((x) => x.mode === "wall-of-text")!;
    expect(c.flagged).toBe(true);
    expect(c.score).toBeGreaterThan(1);
  });

  it("flags sycophancy", () => {
    const syco =
      "Great question! You're absolutely right, and I'd be happy to help.";
    const c = critique(syco).find((x) => x.mode === "sycophancy")!;
    expect(c.flagged).toBe(true);
  });

  it("flags emoji overload", () => {
    const spam = "yes 🔥 no 🎉 ok 💯 sure 🚀 cool 😎";
    const c = critique(spam).find((x) => x.mode === "emoji-overload")!;
    expect(c.flagged).toBe(true);
  });

  it("respects custom thresholds", () => {
    const lenient = { ...DEFAULT_THRESHOLDS, maxTokens: 100000 };
    const wall = "word ".repeat(2000);
    const c = critique(wall, lenient).find((x) => x.mode === "wall-of-text")!;
    expect(c.flagged).toBe(false);
  });
});
