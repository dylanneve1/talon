/**
 * Tests for Personalized PageRank over the value co-activation graph.
 */

import { describe, expect, it } from "vitest";
import { SoulDag } from "../core/soul/dag.js";
import { pagerank } from "../core/soul/centrality.js";
import { coactivate } from "../core/soul/salience.js";
import type { EvidencePayload, Hash } from "../core/soul/types.js";

function value(dag: SoulDag, text: string): Hash {
  const e = dag.addNode({
    kind: "evidence",
    text,
    observedAt: 0,
    source: { origin: "seed" },
  } satisfies EvidencePayload);
  return dag.addNode({ kind: "value", members: [e], medoid: e });
}

describe("pagerank", () => {
  it("returns a probability distribution over values", () => {
    const dag = new SoulDag();
    const a = value(dag, "a");
    const b = value(dag, "b");
    coactivate(dag, [a, b], { now: 0, increment: 1 });
    const pr = pagerank(dag);
    const sum = [...pr.values()].reduce((s, x) => s + x, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("ranks a hub above its leaves", () => {
    const dag = new SoulDag();
    const hub = value(dag, "hub");
    const leaves = [value(dag, "l1"), value(dag, "l2"), value(dag, "l3")];
    // every leaf co-activates with the hub
    for (const l of leaves) {
      for (let t = 0; t < 3; t++)
        coactivate(dag, [hub, l], { now: t, increment: 1 });
    }
    const pr = pagerank(dag);
    for (const l of leaves) {
      expect(pr.get(hub)!).toBeGreaterThan(pr.get(l)!);
    }
  });

  it("personalization biases mass toward the seed", () => {
    const dag = new SoulDag();
    const a = value(dag, "a");
    const b = value(dag, "b");
    const c = value(dag, "c");
    coactivate(dag, [a, b], { now: 0, increment: 1 });
    coactivate(dag, [b, c], { now: 1, increment: 1 });
    const uniform = pagerank(dag);
    const biased = pagerank(dag, { personalization: new Map([[c, 1]]) });
    expect(biased.get(c)!).toBeGreaterThan(uniform.get(c)!);
  });

  it("is empty with no values", () => {
    expect(pagerank(new SoulDag()).size).toBe(0);
  });
});
