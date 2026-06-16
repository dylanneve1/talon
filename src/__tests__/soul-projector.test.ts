/**
 * Tests for the projector. The contract under test: the surface is *selected*
 * from verbatim evidence, salience-ordered, reflexes never dropped, lens
 * amplification reorders, and the token budget is respected.
 */

import { describe, expect, it } from "vitest";
import { SoulDag } from "../core/soul/dag.js";
import { projectRuntime, estimateTokens } from "../core/soul/projector.js";
import { reinforce } from "../core/soul/salience.js";
import { seedReflexes } from "../core/soul/reflex.js";
import {
  DEFAULT_SOUL_CONFIG,
  type EvidencePayload,
  type Hash,
} from "../core/soul/types.js";

const cfg = DEFAULT_SOUL_CONFIG;

function seedValue(dag: SoulDag, text: string, salience: number): Hash {
  const e = dag.addNode({
    kind: "evidence",
    text,
    observedAt: 0,
    source: { origin: "seed" },
  } satisfies EvidencePayload);
  const v = dag.addNode({ kind: "value", members: [e], medoid: e });
  reinforce(dag, v, {
    now: 0,
    halfLifeMs: cfg.decayHalfLifeMs,
    amount: salience,
    valence: 1,
  });
  return v;
}

describe("projectRuntime", () => {
  it("renders values verbatim, highest salience first", () => {
    const dag = new SoulDag();
    seedValue(dag, "be concise, no filler", 2);
    seedValue(dag, "push back on bad ideas", 9);
    const out = projectRuntime(dag, { now: 0, config: cfg });
    const concise = out.text.indexOf("be concise");
    const push = out.text.indexOf("push back");
    expect(push).toBeGreaterThan(-1);
    expect(push).toBeLessThan(concise); // higher salience appears first
  });

  it("only quotes ground truth — no invented text", () => {
    const dag = new SoulDag();
    seedValue(dag, "verify before stating", 5);
    const out = projectRuntime(dag, { now: 0, config: cfg });
    // every value bullet must contain a quoted verbatim fragment
    for (const line of out.text.split("\n")) {
      if (line.startsWith("- [conf")) {
        expect(line).toContain('"verify before stating"');
      }
    }
  });

  it("always includes reflexes even under a tiny budget", () => {
    const dag = new SoulDag();
    for (const r of seedReflexes()) dag.addNode(r);
    seedValue(dag, "this value should be budgeted away entirely", 5);
    const tiny = { ...cfg, runtimeBudgetTokens: 1 };
    const out = projectRuntime(dag, { now: 0, config: tiny });
    expect(out.text).toContain("RULE-0-DELIVERY");
    expect(out.droppedValues).toBeGreaterThan(0);
  });

  it("respects the token budget for values", () => {
    const dag = new SoulDag();
    for (let i = 0; i < 50; i++) {
      seedValue(dag, `value number ${i} with some padding text here`, i);
    }
    const out = projectRuntime(dag, {
      now: 0,
      config: { ...cfg, runtimeBudgetTokens: 60 },
    });
    expect(out.tokens).toBeLessThanOrEqual(estimateTokens(out.text));
    expect(out.droppedValues).toBeGreaterThan(0);
    expect(out.includedValues.length).toBeGreaterThan(0);
  });

  it("amplifies lensed values for the active subject", () => {
    const dag = new SoulDag();
    const quiet = seedValue(dag, "low base salience trait", 1);
    seedValue(dag, "high base salience trait", 8);
    // A Dylan lens amplifies the quiet trait 20x → it should now rank first.
    const ev = dag.addNode({
      kind: "evidence",
      text: "dylan-specific note",
      observedAt: 0,
      source: { origin: "seed" },
    });
    dag.addNode({
      kind: "lens",
      subject: "dylan",
      amplify: [{ node: quiet, factor: 20 }],
      evidence: [ev],
    });
    const out = projectRuntime(dag, { now: 0, config: cfg, lens: "dylan" });
    expect(out.text).toContain("## Values (with dylan)");
    expect(out.text.indexOf("low base salience")).toBeLessThan(
      out.text.indexOf("high base salience"),
    );
  });
});
