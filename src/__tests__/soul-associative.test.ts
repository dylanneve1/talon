/**
 * Tests for modern-Hopfield associative recall and priming over the lattice.
 */

import { describe, expect, it } from "vitest";
import { SoulDag } from "../core/soul/dag.js";
import { associativeRecall, prime } from "../core/soul/associative.js";
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

describe("associativeRecall", () => {
  it("recalls the strongest-bound partner first and forms a distribution", () => {
    const dag = new SoulDag();
    const direct = value(dag, "be direct");
    const pushback = value(dag, "push back");
    const sticker = value(dag, "send a sticker");
    // push-back fires with be-direct a lot, with sticker once
    for (let t = 0; t < 5; t++)
      coactivate(dag, [pushback, direct], { now: t, increment: 1 });
    coactivate(dag, [pushback, sticker], { now: 6, increment: 1 });

    const recalled = associativeRecall(dag, [pushback]);
    expect(recalled[0]!.node).toBe(direct);
    const sum = recalled.reduce((s, r) => s + r.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("excludes the cue itself and returns empty with no bonds", () => {
    const dag = new SoulDag();
    const a = value(dag, "lonely value");
    expect(associativeRecall(dag, [a])).toHaveLength(0);
  });

  it("higher beta sharpens toward the strongest bond", () => {
    const dag = new SoulDag();
    const cue = value(dag, "cue");
    const strong = value(dag, "strong");
    const weak = value(dag, "weak");
    for (let t = 0; t < 4; t++)
      coactivate(dag, [cue, strong], { now: t, increment: 1 });
    coactivate(dag, [cue, weak], { now: 5, increment: 1 });

    const soft = associativeRecall(dag, [cue], { beta: 0.1 });
    const sharp = associativeRecall(dag, [cue], { beta: 5 });
    const softTop = soft.find((r) => r.node === strong)!.weight;
    const sharpTop = sharp.find((r) => r.node === strong)!.weight;
    expect(sharpTop).toBeGreaterThan(softTop);
  });
});

describe("prime", () => {
  it("injects salience into bound partners proportional to recall weight", () => {
    const dag = new SoulDag();
    const cue = value(dag, "cue");
    const partner = value(dag, "partner");
    for (let t = 0; t < 3; t++)
      coactivate(dag, [cue, partner], { now: t, increment: 1 });
    const before = dag.stateOf(partner).salience;
    const primed = prime(dag, [cue], { now: 10, gain: 4 });
    expect(primed).toContain(partner);
    expect(dag.stateOf(partner).salience).toBeGreaterThan(before);
  });
});
