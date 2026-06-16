/**
 * Tests for lattice tension detection: a pair that both co-fires strongly and
 * sits far apart semantically becomes a tension; pairs that fail either
 * condition do not.
 */

import { describe, expect, it } from "vitest";
import { SoulDag } from "../core/soul/dag.js";
import { detectTensions, tensionPairs } from "../core/soul/lattice.js";
import { coactivate } from "../core/soul/salience.js";
import { HashingEmbedder } from "../core/soul/embedder.js";
import type { EvidencePayload, Hash } from "../core/soul/types.js";

const embedder = new HashingEmbedder(512);

function value(dag: SoulDag, text: string): Hash {
  const e = dag.addNode({
    kind: "evidence",
    text,
    observedAt: 0,
    source: { origin: "seed" },
  } satisfies EvidencePayload);
  return dag.addNode({ kind: "value", members: [e], medoid: e });
}

const opts = { minCoactivation: 3, minDistance: 0.5, now: 1 };

describe("detectTensions", () => {
  it("marks a strongly co-active, semantically distant pair as a tension", async () => {
    const dag = new SoulDag();
    const concise = value(dag, "keep replies short and concise");
    const thorough = value(dag, "give exhaustive thorough detailed answers");
    // they fire together a lot
    for (let t = 0; t < 5; t++)
      coactivate(dag, [concise, thorough], { now: t, increment: 1 });

    const edges = await detectTensions(dag, embedder, opts);
    expect(edges.length).toBeGreaterThan(0);
    expect(dag.getEdge(concise, "tension", thorough)).toBeDefined();
  });

  it("does not mark a pair that rarely co-fires", async () => {
    const dag = new SoulDag();
    const a = value(dag, "keep replies short and concise");
    const b = value(dag, "give exhaustive thorough detailed answers");
    coactivate(dag, [a, b], { now: 0, increment: 1 }); // below minCoactivation
    const edges = await detectTensions(dag, embedder, opts);
    expect(edges).toHaveLength(0);
  });

  it("does not mark a co-active but semantically similar pair", async () => {
    const dag = new SoulDag();
    const a = value(dag, "keep replies short and concise");
    const b = value(dag, "keep responses short and concise please");
    for (let t = 0; t < 5; t++)
      coactivate(dag, [a, b], { now: t, increment: 1 });
    const edges = await detectTensions(dag, embedder, opts);
    expect(edges).toHaveLength(0); // too close to be a tension
  });
});

describe("tensionPairs", () => {
  it("dedupes symmetric edges into one pair", async () => {
    const dag = new SoulDag();
    const a = value(dag, "keep replies short and concise");
    const b = value(dag, "give exhaustive thorough detailed answers");
    for (let t = 0; t < 5; t++)
      coactivate(dag, [a, b], { now: t, increment: 1 });
    await detectTensions(dag, embedder, opts);
    expect(tensionPairs(dag)).toHaveLength(1);
  });
});
