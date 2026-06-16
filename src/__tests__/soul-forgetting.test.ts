/**
 * Tests for FSRS/DSR adaptive forgetting: power-law retrievability, stability
 * growth on spaced recall, lapse on correction, and durability vs a transient.
 */

import { describe, expect, it } from "vitest";
import {
  effectiveStrength,
  initialStability,
  nextStability,
  reinforceFsrs,
  retrievability,
} from "../core/soul/forgetting.js";
import { SoulKernel } from "../core/soul/kernel.js";
import {
  DEFAULT_SOUL_CONFIG,
  type ActivationState,
} from "../core/soul/types.js";

const cfg = { ...DEFAULT_SOUL_CONFIG, adaptiveForgetting: true };

function state(): ActivationState {
  return { salience: 0, evidence: 0, activations: 0, lastActivatedAt: 0 };
}

describe("retrievability", () => {
  it("is 1 at t=0 and ≈0.9 at one stability", () => {
    expect(retrievability(0, 1000)).toBe(1);
    expect(retrievability(1000, 1000)).toBeCloseTo(0.9, 2);
  });

  it("higher stability retains better at the same elapsed time", () => {
    expect(retrievability(5000, 10000)).toBeGreaterThan(
      retrievability(5000, 2000),
    );
  });
});

describe("nextStability", () => {
  it("grows on positive recall and more so at low retrievability", () => {
    const s0 = 1000;
    const highR = nextStability(s0, 0.95, 1); // recalled while still strong
    const lowR = nextStability(s0, 0.3, 1); // recalled when nearly forgotten
    expect(highR).toBeGreaterThan(s0);
    expect(lowR).toBeGreaterThan(highR); // spacing effect
  });

  it("shrinks on a correction", () => {
    expect(nextStability(1000, 0.9, -1)).toBeLessThan(1000);
  });
});

describe("reinforceFsrs", () => {
  it("sets an initial stability on first exposure", () => {
    const s = reinforceFsrs(state(), { now: 1, cfg, amount: 1, valence: 1 });
    expect(s.stability).toBeGreaterThan(initialStability(cfg) * 0.9);
  });
});

describe("durability via repeated recall", () => {
  it("a repeatedly-recalled trait outlives a one-off after a long gap", () => {
    const durable = state();
    const transient = state();
    // durable trait recalled across spaced intervals; transient hit once
    for (let t = 0; t < 6; t++) {
      reinforceFsrs(durable, { now: t * 1000, cfg, amount: 1, valence: 1 });
    }
    reinforceFsrs(transient, { now: 0, cfg, amount: 6, valence: 1 });

    const later = 10_000_000;
    expect(effectiveStrength(durable, later, cfg)).toBeGreaterThan(
      effectiveStrength(transient, later, cfg),
    );
  });
});

describe("kernel integration", () => {
  it("accumulates stability when adaptiveForgetting is on", () => {
    const soul = SoulKernel.genesis({
      now: 1,
      config: cfg,
      seedValues: [{ text: "verify before stating" }],
    });
    const v = soul.graph().nodesOfKind("value")[0]!.hash;
    for (let t = 2; t < 8; t++) {
      soul.ingest({
        kind: "reaction",
        at: t * 1000,
        emoji: "🔥",
        activeNodes: [v],
      });
    }
    expect(soul.graph().stateOf(v).stability).toBeDefined();
    expect(soul.graph().stateOf(v).stability!).toBeGreaterThan(
      initialStability(cfg),
    );
  });
});
