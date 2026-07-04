/**
 * Tests for per-node-kind decay stratification (#368). The three node families
 * have different temporal properties: reflexes are seeded behavioral blockers
 * (never decay), evidence/values fade at the base rate, and spine causal links
 * go stale faster. Verifies the config plumbing, the no-decay short-circuits in
 * both the exponential and FSRS paths, and the compiler-level end-to-end
 * behavior.
 */

import { describe, expect, it } from "vitest";
import { SoulDag } from "../core/soul/dag.js";
import { ingest } from "../core/soul/compiler.js";
import { decayFactor, effectiveSalience } from "../core/soul/salience.js";
import {
  effectiveStrength,
  initialStability,
  reinforceFsrs,
} from "../core/soul/forgetting.js";
import {
  DEFAULT_SOUL_CONFIG,
  halfLifeForKind,
  type ActivationState,
  type EvidencePayload,
  type Hash,
  type SoulConfig,
} from "../core/soul/types.js";

const cfg = DEFAULT_SOUL_CONFIG;
const WEEK = 1000 * 60 * 60 * 24 * 7;

function state(overrides: Partial<ActivationState> = {}): ActivationState {
  return {
    salience: 0,
    evidence: 0,
    activations: 0,
    lastActivatedAt: 0,
    ...overrides,
  };
}

function value(dag: SoulDag, text: string): Hash {
  const e = dag.addNode({
    kind: "evidence",
    text,
    observedAt: 0,
    source: { origin: "seed" },
  } satisfies EvidencePayload);
  return dag.addNode({ kind: "value", members: [e], medoid: e });
}

function reflex(dag: SoulDag, name: string): Hash {
  return dag.addNode({
    kind: "reflex",
    name,
    trigger: "always",
    guard: "always",
    action: "deliver via end_turn",
    severity: "block",
  });
}

describe("halfLifeForKind", () => {
  it("returns the per-kind override when configured", () => {
    expect(halfLifeForKind(cfg, "reflex")).toBe(Number.POSITIVE_INFINITY);
    expect(halfLifeForKind(cfg, "spine")).toBeLessThan(cfg.decayHalfLifeMs);
  });

  it("falls back to the base rate for kinds without an entry", () => {
    expect(halfLifeForKind(cfg, "evidence")).toBe(cfg.decayHalfLifeMs);
    expect(halfLifeForKind(cfg, "value")).toBe(cfg.decayHalfLifeMs);
    expect(halfLifeForKind(cfg, "theme")).toBe(cfg.decayHalfLifeMs);
  });

  it("falls back to the base rate when the kind is unknown", () => {
    expect(halfLifeForKind(cfg)).toBe(cfg.decayHalfLifeMs);
  });

  it("falls back entirely when no per-kind map is configured", () => {
    const flat: SoulConfig = { ...cfg, decayHalfLifeByKindMs: undefined };
    expect(halfLifeForKind(flat, "reflex")).toBe(cfg.decayHalfLifeMs);
    expect(halfLifeForKind(flat, "spine")).toBe(cfg.decayHalfLifeMs);
  });

  it("honors a zero override (instant decay) without falling back", () => {
    const zero: SoulConfig = {
      ...cfg,
      decayHalfLifeByKindMs: { spine: 0 },
    };
    expect(halfLifeForKind(zero, "spine")).toBe(0);
  });
});

describe("exponential path with stratified half-lives", () => {
  it("an infinite half-life never decays salience", () => {
    const s = state({ salience: 5, lastActivatedAt: 0 });
    const tenYears = WEEK * 52 * 10;
    expect(effectiveSalience(s, tenYears, halfLifeForKind(cfg, "reflex"))).toBe(
      5,
    );
  });

  it("an infinite half-life overrides a stale FSRS stability", () => {
    // A reflex that acquired stability before stratification landed must still
    // be exempt from decay.
    const s = state({ salience: 5, lastActivatedAt: 0, stability: WEEK });
    expect(
      effectiveSalience(s, WEEK * 100, halfLifeForKind(cfg, "reflex")),
    ).toBe(5);
  });

  it("spine decays faster than values at the same elapsed time", () => {
    const elapsed = WEEK;
    const spineFactor = decayFactor(elapsed, halfLifeForKind(cfg, "spine"));
    const valueFactor = decayFactor(elapsed, halfLifeForKind(cfg, "value"));
    expect(spineFactor).toBeLessThan(valueFactor);
    expect(valueFactor).toBeCloseTo(0.5, 5); // base rate: one half-life
  });
});

describe("FSRS path with stratified half-lives", () => {
  const fsrsCfg: SoulConfig = { ...cfg, adaptiveForgetting: true };

  it("initialStability uses the per-kind half-life for finite kinds", () => {
    expect(initialStability(fsrsCfg, "spine")).toBe(
      halfLifeForKind(fsrsCfg, "spine"),
    );
    expect(initialStability(fsrsCfg, "value")).toBe(fsrsCfg.decayHalfLifeMs);
  });

  it("initialStability never returns Infinity (JSON-safe)", () => {
    expect(Number.isFinite(initialStability(fsrsCfg, "reflex"))).toBe(true);
  });

  it("reinforceFsrs on a no-decay kind accumulates undecayed and skips stability", () => {
    const s = state({ salience: 3, lastActivatedAt: 0 });
    reinforceFsrs(s, {
      now: WEEK * 50,
      cfg: fsrsCfg,
      amount: 1,
      valence: 1,
      kind: "reflex",
    });
    expect(s.salience).toBe(4); // 3 undecayed + 1, despite ~a year of disuse
    expect(s.stability).toBeUndefined();
    expect(s.activations).toBe(1);
  });

  it("reinforceFsrs on a decaying kind still decays before adding", () => {
    const s = state({ salience: 3, lastActivatedAt: 0 });
    reinforceFsrs(s, {
      now: WEEK * 50,
      cfg: fsrsCfg,
      amount: 1,
      valence: 1,
      kind: "value",
    });
    expect(s.salience).toBeLessThan(4);
    expect(s.stability).toBeDefined();
  });

  it("effectiveStrength returns raw salience for a no-decay kind", () => {
    const s = state({ salience: 7, lastActivatedAt: 0, stability: WEEK });
    expect(effectiveStrength(s, WEEK * 100, fsrsCfg, "reflex")).toBe(7);
    expect(effectiveStrength(s, WEEK * 100, fsrsCfg, "value")).toBeLessThan(7);
  });
});

describe("compiler-level stratification", () => {
  it("a reinforced reflex holds salience while a value fades", () => {
    const dag = new SoulDag();
    const v = value(dag, "be concise");
    const r = reflex(dag, "RULE-0-DELIVERY");

    // Reinforce both at t=1 with the same signal.
    ingest(
      dag,
      { kind: "reaction", at: 1, emoji: "👍", activeNodes: [v, r] },
      cfg,
    );
    const valueAtStart = effectiveSalience(
      dag.stateOf(v),
      1,
      halfLifeForKind(cfg, "value"),
    );
    const reflexAtStart = effectiveSalience(
      dag.stateOf(r),
      1,
      halfLifeForKind(cfg, "reflex"),
    );
    expect(valueAtStart).toBeGreaterThan(0);
    expect(reflexAtStart).toBeGreaterThan(0);

    // A month later the value has faded; the reflex has not softened at all.
    const later = 1 + WEEK * 4;
    const valueLater = effectiveSalience(
      dag.stateOf(v),
      later,
      halfLifeForKind(cfg, "value"),
    );
    const reflexLater = effectiveSalience(
      dag.stateOf(r),
      later,
      halfLifeForKind(cfg, "reflex"),
    );
    expect(valueLater).toBeLessThan(valueAtStart);
    expect(reflexLater).toBe(reflexAtStart);
  });

  it("reinforcing a reflex twice composes without intermediate decay", () => {
    const dag = new SoulDag();
    const r = reflex(dag, "PRIVACY-BOUNDARY");
    ingest(
      dag,
      { kind: "reaction", at: 1, emoji: "👍", activeNodes: [r] },
      cfg,
    );
    const afterFirst = dag.stateOf(r).salience;
    ingest(
      dag,
      { kind: "reaction", at: 1 + WEEK * 10, emoji: "👍", activeNodes: [r] },
      cfg,
    );
    // Ten weeks of disuse cost the reflex nothing: bumps add exactly.
    expect(dag.stateOf(r).salience).toBeCloseTo(afterFirst * 2, 10);
  });
});
