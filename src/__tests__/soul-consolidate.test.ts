/**
 * Tests for organic consolidation — the self-reorganizing "dream". Values that
 * have drifted together merge, learned state migrates forward, superseded values
 * leave projection, and the merge threshold adapts to the lattice.
 */

import { describe, expect, it } from "vitest";
import { SoulDag } from "../core/soul/dag.js";
import {
  consolidate,
  isSuperseded,
  liveValues,
} from "../core/soul/consolidate.js";
import { reinforce } from "../core/soul/salience.js";
import { TalonEmbedder } from "../core/soul/talon-embedder.js";
import {
  DEFAULT_SOUL_CONFIG,
  type EvidencePayload,
  type Hash,
} from "../core/soul/types.js";

const embedder = new TalonEmbedder();
const cfg = DEFAULT_SOUL_CONFIG;

function value(dag: SoulDag, texts: string[]): Hash {
  const members = texts.map((t) =>
    dag.addNode({
      kind: "evidence",
      text: t,
      observedAt: 0,
      source: { origin: "seed" },
    } satisfies EvidencePayload),
  );
  return dag.addNode({ kind: "value", members, medoid: members[0]! });
}

describe("consolidate", () => {
  it("merges two values whose medoids have drifted together", async () => {
    const dag = new SoulDag();
    const a = value(dag, ["keep replies concise and short"]);
    const b = value(dag, ["keep replies short and concise please"]);
    value(dag, ["book a flight to nice in june"]); // unrelated, stays alone

    reinforce(dag, a, {
      now: 1,
      halfLifeMs: cfg.decayHalfLifeMs,
      amount: 3,
      valence: 2,
    });
    reinforce(dag, b, {
      now: 1,
      halfLifeMs: cfg.decayHalfLifeMs,
      amount: 5,
      valence: 4,
    });

    const res = await consolidate(dag, embedder, cfg, {
      now: 2,
      mergeThreshold: 0.5,
    });
    expect(res.created.length).toBe(1);
    expect(res.superseded.length).toBe(2);
    // exactly the unrelated value plus the new merged one remain live
    expect(liveValues(dag).length).toBe(2);
  });

  it("migrates learned salience and evidence into the merged value", async () => {
    const dag = new SoulDag();
    const a = value(dag, ["be sharp and direct"]);
    const b = value(dag, ["stay sharp, be direct"]);
    reinforce(dag, a, {
      now: 1,
      halfLifeMs: cfg.decayHalfLifeMs,
      amount: 4,
      valence: 3,
    });
    reinforce(dag, b, {
      now: 1,
      halfLifeMs: cfg.decayHalfLifeMs,
      amount: 6,
      valence: 5,
    });

    const res = await consolidate(dag, embedder, cfg, {
      now: 1,
      mergeThreshold: 0.6,
    });
    const merged = res.created[0]!;
    // salience ≈ 4 + 6, evidence = 3 + 5 — nothing learned is lost
    expect(dag.stateOf(merged).salience).toBeCloseTo(10, 5);
    expect(dag.stateOf(merged).evidence).toBe(8);
    expect(isSuperseded(dag, a)).toBe(true);
  });

  it("leaves a lattice of distinct values untouched", async () => {
    const dag = new SoulDag();
    value(dag, ["be concise"]);
    value(dag, ["verify facts with tools"]);
    value(dag, ["push back on bad ideas"]);
    const res = await consolidate(dag, embedder, cfg, { now: 1 });
    expect(res.created).toHaveLength(0);
    expect(liveValues(dag)).toHaveLength(3);
  });

  it("derives an adaptive threshold from the lattice when none is given", async () => {
    const dag = new SoulDag();
    value(dag, ["alpha one"]);
    value(dag, ["alpha two"]);
    const res = await consolidate(dag, embedder, cfg, { now: 1 });
    expect(res.threshold).toBeGreaterThan(0);
  });
});
