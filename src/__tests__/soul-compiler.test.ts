/**
 * Tests for the compiler — the model-free ingest loop. Verifies each signal kind
 * routes to the right arithmetic and that evidence is stored verbatim.
 */

import { describe, expect, it } from "vitest";
import { SoulDag } from "../core/soul/dag.js";
import { ingest, ingestAll, appendSpine } from "../core/soul/compiler.js";
import { confidence } from "../core/soul/salience.js";
import {
  DEFAULT_SOUL_CONFIG,
  type EvidencePayload,
  type Hash,
} from "../core/soul/types.js";

const cfg = DEFAULT_SOUL_CONFIG;

function value(dag: SoulDag, text: string): Hash {
  const e = dag.addNode({
    kind: "evidence",
    text,
    observedAt: 0,
    source: { origin: "seed" },
  } satisfies EvidencePayload);
  return dag.addNode({ kind: "value", members: [e], medoid: e });
}

describe("reaction signals", () => {
  it("a positive emoji reinforces the active values", () => {
    const dag = new SoulDag();
    const v = value(dag, "concise");
    ingest(
      dag,
      { kind: "reaction", at: 1, emoji: "🔥", activeNodes: [v] },
      cfg,
    );
    expect(dag.stateOf(v).salience).toBeGreaterThan(0);
    expect(confidence(dag.stateOf(v))).toBeGreaterThan(0);
  });

  it("a negative emoji drives confidence down", () => {
    const dag = new SoulDag();
    const v = value(dag, "wall of text");
    ingest(
      dag,
      { kind: "reaction", at: 1, emoji: "👎", activeNodes: [v] },
      cfg,
    );
    expect(confidence(dag.stateOf(v))).toBeLessThan(0);
  });

  it("co-activates a set that fired together", () => {
    const dag = new SoulDag();
    const a = value(dag, "a");
    const b = value(dag, "b");
    ingest(
      dag,
      { kind: "reaction", at: 1, emoji: "👍", activeNodes: [a, b] },
      cfg,
    );
    expect(dag.getEdge(a, "coactivation", b)?.weight).toBe(cfg.hebbIncrement);
  });
});

describe("engagement signals", () => {
  it("a dead conversation penalizes the active values", () => {
    const dag = new SoulDag();
    const v = value(dag, "rambling");
    ingest(
      dag,
      { kind: "engagement", at: 1, continued: false, activeNodes: [v] },
      cfg,
    );
    expect(confidence(dag.stateOf(v))).toBeLessThan(0);
  });
});

describe("correction signals", () => {
  it("stores the verbatim text as evidence and appends a spine event", () => {
    const dag = new SoulDag();
    const v = value(dag, "performative eagle stuff");
    const res = ingest(
      dag,
      {
        kind: "correction",
        at: 5,
        text: "just be grounded and talk naturally",
        actor: "dylan",
        activeNodes: [v],
      },
      cfg,
    );
    expect(res.evidenceAdded).toBeDefined();
    const ev = dag.getNode(res.evidenceAdded!);
    expect(ev?.payload.kind).toBe("evidence");
    expect((ev!.payload as EvidencePayload).text).toBe(
      "just be grounded and talk naturally",
    );
    expect(res.spineAdded).toBeDefined();
    // the active value was penalized
    expect(confidence(dag.stateOf(v))).toBeLessThan(0);
  });
});

describe("reflex-fire signals", () => {
  it("records a blocked misstep in the spine but ignores soft fires", () => {
    const dag = new SoulDag();
    const blocked = ingest(
      dag,
      {
        kind: "reflex-fire",
        at: 1,
        name: "RULE-0-DELIVERY",
        severity: "block",
      },
      cfg,
    );
    expect(blocked.spineAdded).toBeDefined();
    const soft = ingest(
      dag,
      { kind: "reflex-fire", at: 2, name: "X", severity: "advise" },
      cfg,
    );
    expect(soft.spineAdded).toBeUndefined();
  });
});

describe("spine chaining", () => {
  it("links each new event to the previous one", () => {
    const dag = new SoulDag();
    const first = appendSpine(dag, "genesis", 1);
    const second = appendSpine(dag, "second", 2);
    const node = dag.getNode(second);
    expect(node?.payload.kind).toBe("spine");
    if (node?.payload.kind === "spine") {
      expect(node.payload.prev).toBe(first);
    }
  });
});

describe("ingestAll", () => {
  it("applies a batch in order", () => {
    const dag = new SoulDag();
    const v = value(dag, "x");
    const results = ingestAll(
      dag,
      [
        { kind: "reaction", at: 1, emoji: "👍", activeNodes: [v] },
        { kind: "reaction", at: 2, emoji: "👍", activeNodes: [v] },
      ],
      cfg,
    );
    expect(results).toHaveLength(2);
    expect(dag.stateOf(v).activations).toBe(2);
  });
});
