/**
 * Tests for relational holograph lens compilation — identity refracted per
 * subject from actor-tagged evidence.
 */

import { describe, expect, it } from "vitest";
import { SoulKernel } from "../core/soul/kernel.js";
import { compileLens, liveLens } from "../core/soul/lens.js";
import type { LensPayload } from "../core/soul/types.js";

describe("compileLens", () => {
  it("amplifies values built from the subject's evidence", () => {
    const soul = SoulKernel.genesis({
      now: 1,
      seedValues: [
        { text: "deep technical rabbit holes", actor: "dylan" },
        { text: "send a sticker to the group", actor: "pawel" },
      ],
    });
    const lens = compileLens(soul.graph(), "dylan", { now: 2 })!;
    expect(lens).toBeDefined();
    const payload = soul.graph().getNode(lens)!.payload as LensPayload;
    expect(payload.subject).toBe("dylan");
    expect(payload.amplify.length).toBe(1); // only the dylan value
    expect(payload.amplify[0]!.factor).toBeGreaterThan(1);
  });

  it("returns undefined for a subject with no evidence", () => {
    const soul = SoulKernel.genesis({ now: 1, seedValues: [{ text: "x" }] });
    expect(compileLens(soul.graph(), "nobody", { now: 2 })).toBeUndefined();
  });

  it("recompiling supersedes the prior lens for the subject", () => {
    const soul = SoulKernel.genesis({
      now: 1,
      seedValues: [{ text: "sharp and direct", actor: "dylan" }],
    });
    const first = compileLens(soul.graph(), "dylan", { now: 2 })!;
    const second = compileLens(soul.graph(), "dylan", { now: 3 })!;
    // identical content dedupes to the same node; force a change then recompile
    soul.ingest({
      kind: "directive",
      at: 4,
      text: "be playful with dylan",
      actor: "dylan",
    });
    const third = compileLens(soul.graph(), "dylan", { now: 5 })!;
    expect(third).not.toBe(first);
    expect(liveLens(soul.graph(), "dylan")).toBe(third);
    void second;
  });

  it("the projected lens refracts the soul toward the subject", () => {
    const soul = SoulKernel.genesis({
      now: 1,
      seedValues: [
        { text: "deep technical rabbit holes with dylan", actor: "dylan" },
        { text: "casual group banter" },
      ],
    });
    // both values earn equal salience; the lens then amplifies dylan's
    const vals = soul
      .graph()
      .nodesOfKind("value")
      .map((n) => n.hash);
    for (const v of vals) {
      soul.ingest({ kind: "reaction", at: 2, emoji: "🔥", activeNodes: [v] });
    }
    compileLens(soul.graph(), "dylan", { now: 3, boost: 10 });
    soul.commit("lens", 3);
    const out = soul.project({ now: 3, lens: "dylan" });
    const firstValue = out.text
      .split("\n")
      .find((l) => l.startsWith("- [conf"));
    expect(firstValue).toContain("dylan");
  });
});
