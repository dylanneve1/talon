/**
 * Tests for the delta stream — templated "what changed in me" between commits.
 */

import { describe, expect, it } from "vitest";
import { diffSnapshots, renderDelta } from "../core/soul/delta.js";
import { SoulKernel } from "../core/soul/kernel.js";

describe("diffSnapshots", () => {
  it("reports added values between two commits", () => {
    const soul = SoulKernel.genesis({ now: 1 });
    const before = soul.graph().snapshot();
    soul.addSeedValue("verify before stating", 2);
    const after = soul.graph().snapshot();
    const delta = diffSnapshots(before, after);
    expect(delta.addedValues).toContain("verify before stating");
    expect(renderDelta(delta)).toContain("value");
  });

  it("reports no structural change for an empty diff", () => {
    const soul = SoulKernel.genesis({ now: 1 });
    const snap = soul.graph().snapshot();
    expect(renderDelta(diffSnapshots(snap, snap))).toBe("no structural change");
  });
});

describe("kernel delta", () => {
  it("commit summaries describe what changed", () => {
    const soul = SoulKernel.genesis({ now: 1 });
    soul.addSeedValue("push back on bad ideas", 2);
    const commit = soul.commit("learning", 3);
    expect(commit.summary).toMatch(/^learning:/);
    expect(commit.summary).toContain("value");
    expect(soul.delta().addedValues).toContain("push back on bad ideas");
  });

  it("a correction shows up as a spine addition in the delta", () => {
    const soul = SoulKernel.genesis({ now: 1 });
    soul.ingest({
      kind: "correction",
      at: 2,
      text: "be grounded",
      actor: "dylan",
    });
    soul.commit("c", 3);
    expect(soul.delta().addedSpine.some((s) => s.includes("be grounded"))).toBe(
      true,
    );
  });
});
