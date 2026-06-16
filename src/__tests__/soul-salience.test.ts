/**
 * Tests for salience dynamics — the pure-arithmetic learning core. These pin the
 * numeric behavior of decay, reinforcement, Hebbian edges, and the delta rule.
 */

import { describe, expect, it } from "vitest";
import { SoulDag } from "../core/soul/dag.js";
import {
  applyPredictionError,
  coactivate,
  confidence,
  decayFactor,
  effectiveSalience,
  reinforce,
} from "../core/soul/salience.js";
import type { EvidencePayload, Hash } from "../core/soul/types.js";

const HL = 1000; // 1s half-life for readable tests

function ev(text: string): EvidencePayload {
  return { kind: "evidence", text, observedAt: 0, source: { origin: "seed" } };
}

describe("decayFactor", () => {
  it("is 1 at t=0 and 0.5 at one half-life", () => {
    expect(decayFactor(0, HL)).toBe(1);
    expect(decayFactor(HL, HL)).toBeCloseTo(0.5, 10);
    expect(decayFactor(2 * HL, HL)).toBeCloseTo(0.25, 10);
  });
});

describe("reinforce", () => {
  it("adds salience and accumulates signed evidence", () => {
    const dag = new SoulDag();
    const h = dag.addNode(ev("concise"));
    reinforce(dag, h, { now: 0, halfLifeMs: HL, amount: 2, valence: 1 });
    expect(dag.stateOf(h).salience).toBe(2);
    expect(dag.stateOf(h).evidence).toBe(1);
    expect(dag.stateOf(h).activations).toBe(1);
  });

  it("decays prior salience before adding the new bump", () => {
    const dag = new SoulDag();
    const h = dag.addNode(ev("x"));
    reinforce(dag, h, { now: 0, halfLifeMs: HL, amount: 4, valence: 0 });
    // one half-life later, the 4 has decayed to 2, then +4 = 6
    reinforce(dag, h, { now: HL, halfLifeMs: HL, amount: 4, valence: 0 });
    expect(dag.stateOf(h).salience).toBeCloseTo(6, 10);
  });

  it("a correction drives evidence (and confidence) negative", () => {
    const dag = new SoulDag();
    const h = dag.addNode(ev("wall of text"));
    reinforce(dag, h, { now: 0, halfLifeMs: HL, amount: 0, valence: -3 });
    expect(confidence(dag.stateOf(h))).toBeLessThan(0);
  });
});

describe("effectiveSalience", () => {
  it("reflects time-decay without mutating stored state", () => {
    const dag = new SoulDag();
    const h = dag.addNode(ev("x"));
    reinforce(dag, h, { now: 0, halfLifeMs: HL, amount: 8, valence: 0 });
    const s = dag.stateOf(h);
    expect(effectiveSalience(s, HL, HL)).toBeCloseTo(4, 10);
    expect(s.salience).toBe(8); // stored value untouched by the read
  });
});

describe("coactivate", () => {
  it("creates symmetric edges for every pair", () => {
    const dag = new SoulDag();
    const a = dag.addNode(ev("a"));
    const b = dag.addNode(ev("b"));
    const c = dag.addNode(ev("c"));
    coactivate(dag, [a, b, c], { now: 0, increment: 1 });
    expect(dag.getEdge(a, "coactivation", b)?.weight).toBe(1);
    expect(dag.getEdge(b, "coactivation", a)?.weight).toBe(1);
    expect(dag.edgesFrom(a, "coactivation")).toHaveLength(2);
  });

  it("accumulates on repeated co-activation", () => {
    const dag = new SoulDag();
    const a = dag.addNode(ev("a"));
    const b = dag.addNode(ev("b"));
    coactivate(dag, [a, b], { now: 0, increment: 1 });
    coactivate(dag, [a, b], { now: 1, increment: 1 });
    expect(dag.getEdge(a, "coactivation", b)?.weight).toBe(2);
  });
});

describe("applyPredictionError", () => {
  it("moves salience a learningRate-fraction toward the observation", () => {
    const dag = new SoulDag();
    const h = dag.addNode(ev("x"));
    // predicted 0, observed 10, lr 0.5 → 5
    const err = applyPredictionError(dag, h, 10, {
      now: 0,
      halfLifeMs: HL,
      learningRate: 0.5,
    });
    expect(err).toBe(10);
    expect(dag.stateOf(h).salience).toBeCloseTo(5, 10);
  });

  it("floors salience at zero on a strong negative surprise", () => {
    const dag = new SoulDag();
    const h = dag.addNode(ev("x"));
    reinforce(dag, h, { now: 0, halfLifeMs: HL, amount: 2, valence: 0 });
    applyPredictionError(dag, h, -100, {
      now: 0,
      halfLifeMs: HL,
      learningRate: 1,
    });
    expect(dag.stateOf(h).salience).toBe(0);
  });
});
