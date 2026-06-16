/**
 * Tests for the VSA/HDC algebra and compositional episodic memory. These pin the
 * properties the soul relies on: bind is invertible, bundle is similar to its
 * parts, and a context query cleans up to the right value.
 */

import { describe, expect, it } from "vitest";
import {
  CompositionalMemory,
  bind,
  bundle,
  cleanup,
  hdCosine,
  permute,
  symbolVector,
} from "../core/soul/hdc.js";

describe("symbolVector", () => {
  it("is deterministic and near-orthogonal for distinct tokens", () => {
    expect(symbolVector("dylan")).toEqual(symbolVector("dylan"));
    const sim = hdCosine(symbolVector("dylan"), symbolVector("pawel"));
    expect(Math.abs(sim)).toBeLessThan(0.1); // quasi-orthogonal in high dim
  });
});

describe("bind", () => {
  it("is its own inverse (unbinding recovers the operand)", () => {
    const a = symbolVector("context");
    const b = symbolVector("value");
    const bound = bind(a, b);
    expect(hdCosine(bound, a)).toBeLessThan(0.2); // dissimilar to both
    const recovered = bind(bound, a);
    expect(hdCosine(recovered, b)).toBeGreaterThan(0.99); // recovers b
  });
});

describe("bundle", () => {
  it("is similar to all of its constituents", () => {
    const a = symbolVector("a");
    const b = symbolVector("b");
    const c = symbolVector("c");
    const set = bundle([a, b, c]);
    for (const v of [a, b, c]) expect(hdCosine(set, v)).toBeGreaterThan(0.3);
  });
});

describe("permute", () => {
  it("produces a dissimilar, reversible shift", () => {
    const a = symbolVector("seq");
    const p = permute(a, 1);
    expect(hdCosine(a, p)).toBeLessThan(0.2);
    expect(permute(p, -1)).toEqual(a);
  });
});

describe("CompositionalMemory", () => {
  it("recalls the value bound to a context, via cleanup", () => {
    const mem = new CompositionalMemory();
    const items = new Map([
      ["concise", symbolVector("concise")],
      ["pushback", symbolVector("pushback")],
      ["verify", symbolVector("verify")],
    ]);
    // remember: in context "quick" → concise; in "argument" → pushback
    mem.add(symbolVector("quick"), items.get("concise")!);
    mem.add(symbolVector("argument"), items.get("pushback")!);

    const recalled = cleanup(mem.query(symbolVector("quick")), items);
    expect(recalled!.token).toBe("concise");
    const recalled2 = cleanup(mem.query(symbolVector("argument")), items);
    expect(recalled2!.token).toBe("pushback");
  });

  it("snapshots and restores losslessly", () => {
    const mem = new CompositionalMemory();
    mem.add(symbolVector("c"), symbolVector("v"));
    const r = CompositionalMemory.restore(mem.snapshot());
    expect(r.episodes).toBe(1);
    expect(r.vector()).toEqual(mem.vector());
  });
});

describe("kernel episodic memory", () => {
  it("recalls the value tied to a context after remembering episodes", async () => {
    const { SoulKernel } = await import("../core/soul/kernel.js");
    const soul = SoulKernel.genesis({
      now: 1,
      seedValues: [{ text: "keep it concise" }, { text: "push back hard" }],
    });
    const [concise, pushback] = soul
      .graph()
      .nodesOfKind("value")
      .map((n) => n.hash);
    soul.rememberEpisode("quick simple question", [concise!]);
    soul.rememberEpisode("heated argument debate", [pushback!]);

    const recalled = soul.recallByContext("a quick simple question");
    expect(recalled!.value).toBe(concise);
  });

  it("returns undefined before any episode is remembered", async () => {
    const { SoulKernel } = await import("../core/soul/kernel.js");
    const soul = SoulKernel.genesis({ now: 1, seedValues: [{ text: "x" }] });
    expect(soul.recallByContext("anything")).toBeUndefined();
  });
});
