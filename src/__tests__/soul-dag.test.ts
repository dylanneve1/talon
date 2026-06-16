/**
 * Tests for the DAG store: referential integrity, dedup/idempotency, dirty
 * propagation up the structural spine, and snapshot round-tripping.
 */

import { describe, expect, it } from "vitest";
import { SoulDag, structuralChildren } from "../core/soul/dag.js";
import { hashPayload } from "../core/soul/hash.js";
import type {
  EvidencePayload,
  ValuePayload,
  Hash,
} from "../core/soul/types.js";

function evidence(text: string, at = 1): EvidencePayload {
  return {
    kind: "evidence",
    text,
    observedAt: at,
    source: { origin: "seed" },
  };
}

describe("structuralChildren", () => {
  it("returns no children for evidence and reflex", () => {
    expect(structuralChildren(evidence("x"))).toEqual([]);
  });

  it("returns medoid + members for a value, deduped", () => {
    const m = hashPayload(evidence("a"));
    const value: ValuePayload = {
      kind: "value",
      members: [m, m],
      medoid: m,
    };
    expect(structuralChildren(value)).toEqual([m]);
  });
});

describe("SoulDag.addNode", () => {
  it("is idempotent on identical content", () => {
    const dag = new SoulDag();
    const a = dag.addNode(evidence("be grounded"));
    const b = dag.addNode(evidence("be grounded"));
    expect(a).toBe(b);
    expect(dag.size).toBe(1);
  });

  it("throws on a dangling structural reference", () => {
    const dag = new SoulDag();
    const ghost = ("sha256:" + "f".repeat(64)) as Hash;
    expect(() =>
      dag.addNode({ kind: "value", members: [ghost], medoid: ghost }),
    ).toThrow(/dangling/);
  });

  it("links a value to its evidence and records parents", () => {
    const dag = new SoulDag();
    const e1 = dag.addNode(evidence("concise"));
    const e2 = dag.addNode(evidence("no filler"));
    const v = dag.addNode({ kind: "value", members: [e1, e2], medoid: e1 });
    expect(dag.childrenOf(v).sort()).toEqual([e1, e2].sort());
    expect(dag.parentsOf(e1)).toContain(v);
  });
});

describe("dirty-tracking", () => {
  it("propagates dirt from a child up to its parents", () => {
    const dag = new SoulDag();
    const e = dag.addNode(evidence("x"));
    const v = dag.addNode({ kind: "value", members: [e], medoid: e });
    dag.clearDirty();

    dag.touch(e);
    const dirty = dag.dirtySet();
    expect(dirty.has(e)).toBe(true);
    expect(dirty.has(v)).toBe(true); // parent recompiles when child moves
  });

  it("clears after a commit boundary", () => {
    const dag = new SoulDag();
    dag.addNode(evidence("x"));
    expect(dag.dirtySet().size).toBeGreaterThan(0);
    dag.clearDirty();
    expect(dag.dirtySet().size).toBe(0);
  });
});

describe("root", () => {
  it("changes when content is added, stable otherwise", () => {
    const dag = new SoulDag();
    dag.addNode(evidence("a"));
    const r1 = dag.root();
    dag.addNode(evidence("a")); // dup → no change
    expect(dag.root()).toBe(r1);
    dag.addNode(evidence("b"));
    expect(dag.root()).not.toBe(r1);
  });
});

describe("snapshot / restore", () => {
  it("round-trips nodes, state, and edges", () => {
    const dag = new SoulDag();
    const e1 = dag.addNode(evidence("concise"));
    const e2 = dag.addNode(evidence("thorough"));
    const v = dag.addNode({ kind: "value", members: [e1, e2], medoid: e1 });
    dag.stateOf(v).salience = 4.2;
    dag.edge(e1, "tension", e2).weight = 3;

    const restored = SoulDag.restore(dag.snapshot());
    expect(restored.root()).toBe(dag.root());
    expect(restored.stateOf(v).salience).toBe(4.2);
    expect(restored.getEdge(e1, "tension", e2)?.weight).toBe(3);
    expect(restored.dirtySet().size).toBe(0);
  });

  it("rejects a snapshot with a missing child", () => {
    const dag = new SoulDag();
    const e = dag.addNode(evidence("x"));
    const v = dag.addNode({ kind: "value", members: [e], medoid: e });
    const snap = dag.snapshot();
    const broken = { ...snap, nodes: snap.nodes.filter((n) => n.hash !== e) };
    expect(() => SoulDag.restore(broken)).toThrow(/missing child/);
    void v;
  });
});
