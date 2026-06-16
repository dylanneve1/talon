/**
 * Soul Kernel — the content-addressed DAG store.
 *
 * Holds three things, kept rigorously separate:
 *
 *   1. Nodes   — immutable, content-addressed identity content (the Merkle DAG).
 *   2. State   — mutable per-node "weather" (salience, evidence weight).
 *   3. Edges   — mutable associative links (Hebbian co-activation, tension).
 *
 * Referential integrity is enforced on insert: a node may only reference child
 * hashes that already exist, so the DAG can never contain a dangling pointer and
 * the Merkle root is always sound.
 *
 * Dirty-tracking is structural and underpins "partial recompilation": only the
 * nodes added or whose state mutated since the last commit are reported dirty, so
 * downstream consumers (projector, critic) reprocess a handful of nodes, not the
 * whole self.
 */

import { hashPayload, merkleRoot } from "./hash.js";
import type {
  ActivationState,
  AssocEdge,
  EdgeKind,
  Hash,
  NodePayload,
  SoulNode,
} from "./types.js";

/** The structural (hashed) children a payload references, by kind. */
export function structuralChildren(payload: NodePayload): Hash[] {
  switch (payload.kind) {
    case "evidence":
    case "reflex":
      return [];
    case "value":
      return dedupe([payload.medoid, ...payload.members]);
    case "theme":
      return dedupe([payload.medoid, ...payload.values]);
    case "spine":
      return dedupe([
        ...payload.affects,
        ...(payload.prev ? [payload.prev] : []),
      ]);
    case "lens":
      return dedupe([
        ...payload.amplify.map((a) => a.node),
        ...payload.evidence,
      ]);
  }
}

function dedupe(hashes: Hash[]): Hash[] {
  return [...new Set(hashes)];
}

function freshState(now: number): ActivationState {
  return { salience: 0, evidence: 0, activations: 0, lastActivatedAt: now };
}

/** Edge map key — one edge per (from, kind, to) triple. */
function edgeKey(from: Hash, kind: EdgeKind, to: Hash): string {
  return `${from}|${kind}|${to}`;
}

export interface DagSnapshot {
  readonly nodes: readonly SoulNode[];
  readonly state: readonly (readonly [Hash, ActivationState])[];
  readonly edges: readonly AssocEdge[];
}

export class SoulDag {
  private readonly nodes = new Map<Hash, SoulNode>();
  private readonly state = new Map<Hash, ActivationState>();
  private readonly edges = new Map<string, AssocEdge>();
  /** Reverse adjacency for structural children → parents, for dirty propagation. */
  private readonly parents = new Map<Hash, Set<Hash>>();
  private readonly dirty = new Set<Hash>();

  // ── Nodes ──────────────────────────────────────────────────────────────────

  /**
   * Insert a node by content. Idempotent: identical content returns the same
   * hash and does not re-dirty. Throws if any structural child is absent.
   */
  addNode(payload: NodePayload, now = Date.now()): Hash {
    const hash = hashPayload(payload);
    if (this.nodes.has(hash)) return hash;

    const children = structuralChildren(payload);
    for (const child of children) {
      if (!this.nodes.has(child)) {
        throw new Error(
          `SoulDag.addNode: dangling reference ${child} from ${payload.kind} node`,
        );
      }
    }

    this.nodes.set(hash, { hash, payload });
    this.state.set(hash, freshState(now));
    for (const child of children) {
      let set = this.parents.get(child);
      if (!set) {
        set = new Set();
        this.parents.set(child, set);
      }
      set.add(hash);
    }
    this.dirty.add(hash);
    return hash;
  }

  getNode(hash: Hash): SoulNode | undefined {
    return this.nodes.get(hash);
  }

  hasNode(hash: Hash): boolean {
    return this.nodes.has(hash);
  }

  /** All node hashes of a given kind. */
  nodesOfKind(kind: NodePayload["kind"]): SoulNode[] {
    const out: SoulNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.payload.kind === kind) out.push(node);
    }
    return out;
  }

  get size(): number {
    return this.nodes.size;
  }

  // ── State ──────────────────────────────────────────────────────────────────

  /** Mutable activation state for a node (lazily created). */
  stateOf(hash: Hash): ActivationState {
    let s = this.state.get(hash);
    if (!s) {
      s = freshState(Date.now());
      this.state.set(hash, s);
    }
    return s;
  }

  /** Mark a node (and its structural ancestors) dirty after a state change. */
  touch(hash: Hash): void {
    if (!this.nodes.has(hash)) return;
    this.dirty.add(hash);
  }

  // ── Edges ──────────────────────────────────────────────────────────────────

  /** Create or fetch the edge for a triple; weight starts at 0. */
  edge(from: Hash, kind: EdgeKind, to: Hash, now = Date.now()): AssocEdge {
    const key = edgeKey(from, kind, to);
    let e = this.edges.get(key);
    if (!e) {
      e = { from, to, kind, weight: 0, updatedAt: now };
      this.edges.set(key, e);
    }
    return e;
  }

  getEdge(from: Hash, kind: EdgeKind, to: Hash): AssocEdge | undefined {
    return this.edges.get(edgeKey(from, kind, to));
  }

  /** All edges originating at `from`, optionally filtered by kind. */
  edgesFrom(from: Hash, kind?: EdgeKind): AssocEdge[] {
    const out: AssocEdge[] = [];
    for (const e of this.edges.values()) {
      if (e.from === from && (!kind || e.kind === kind)) out.push(e);
    }
    return out;
  }

  /** Every edge in the graph, optionally filtered by kind. */
  allEdges(kind?: EdgeKind): AssocEdge[] {
    const out: AssocEdge[] = [];
    for (const e of this.edges.values()) {
      if (!kind || e.kind === kind) out.push(e);
    }
    return out;
  }

  // ── Structure ────────────────────────────────────────────────────────────────

  childrenOf(hash: Hash): Hash[] {
    const node = this.nodes.get(hash);
    return node ? structuralChildren(node.payload) : [];
  }

  parentsOf(hash: Hash): Hash[] {
    return [...(this.parents.get(hash) ?? [])];
  }

  /** Merkle root over the full set of node content present. The version id. */
  root(): Hash {
    return merkleRoot(this.nodes.keys());
  }

  // ── Dirty-tracking ───────────────────────────────────────────────────────────

  /** Nodes added or touched since the last clear, plus their ancestors. */
  dirtySet(): Set<Hash> {
    const out = new Set<Hash>();
    const stack = [...this.dirty];
    while (stack.length) {
      const h = stack.pop()!;
      if (out.has(h)) continue;
      out.add(h);
      for (const parent of this.parents.get(h) ?? []) stack.push(parent);
    }
    return out;
  }

  clearDirty(): void {
    this.dirty.clear();
  }

  // ── Serialization ────────────────────────────────────────────────────────────

  snapshot(): DagSnapshot {
    return {
      nodes: [...this.nodes.values()],
      state: [...this.state.entries()].map(([h, s]) => [h, { ...s }]),
      edges: [...this.edges.values()].map((e) => ({ ...e })),
    };
  }

  /**
   * Rebuild a DAG from a snapshot. Nodes are re-inserted in dependency order so
   * referential integrity is re-verified on load (a corrupt snapshot throws
   * rather than silently producing a broken graph).
   */
  static restore(snap: DagSnapshot): SoulDag {
    const dag = new SoulDag();
    const byHash = new Map(snap.nodes.map((n) => [n.hash, n]));
    const inserted = new Set<Hash>();

    const insert = (node: SoulNode): void => {
      if (inserted.has(node.hash)) return;
      for (const child of structuralChildren(node.payload)) {
        const childNode = byHash.get(child);
        if (!childNode) {
          throw new Error(`SoulDag.restore: snapshot missing child ${child}`);
        }
        insert(childNode);
      }
      dag.addNode(node.payload);
      inserted.add(node.hash);
    };
    for (const node of snap.nodes) insert(node);

    for (const [hash, s] of snap.state) {
      if (dag.nodes.has(hash)) dag.state.set(hash, { ...s });
    }
    for (const e of snap.edges) {
      dag.edges.set(edgeKey(e.from, e.kind, e.to), { ...e });
    }
    dag.clearDirty();
    return dag;
  }
}
