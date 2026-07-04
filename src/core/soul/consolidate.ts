/**
 * Soul Kernel — organic consolidation ("the dream").
 *
 * Crystallization clusters loose evidence once. Consolidation is what makes the
 * value graph *alive*: it periodically re-examines the whole lattice and lets it
 * reorganize as experience accumulates — values that have drifted together merge
 * into one, carrying their learned salience and evidence forward.
 *
 * Two principles keep it organic rather than over-programmed:
 *
 *   1. The merge threshold is ADAPTIVE — derived from the current distribution of
 *      nearest-neighbor distances among values, not a magic constant. The lattice
 *      decides its own granularity from its own shape, and that shape changes as
 *      it grows.
 *
 *   2. Learned state is MIGRATED, never lost. A merge supersedes the old values
 *      with a new content-addressed node, sums their salience/evidence into it,
 *      and records `supersedes` edges + a Spine event. Nothing is deleted — the
 *      old nodes simply fall out of projection (filtered as superseded) and decay.
 *
 * No model decides what merges. Geometry and accumulated weight do.
 */

import type { SoulDag } from "./dag.js";
import { cosineDistance, medoidIndex, type Embedder } from "./embedder.js";
import { effectiveSalience } from "./salience.js";
import type { Hash, SoulConfig, ValuePayload } from "./types.js";
import { halfLifeForKind } from "./types.js";

/** A value is dead once something supersedes it. */
export function isSuperseded(dag: SoulDag, value: Hash): boolean {
  return dag.allEdges("supersedes").some((e) => e.to === value);
}

/** Live (non-superseded) value nodes. */
export function liveValues(dag: SoulDag): Hash[] {
  return dag
    .nodesOfKind("value")
    .map((n) => n.hash)
    .filter((h) => !isSuperseded(dag, h));
}

function evidenceText(dag: SoulDag, hash: Hash): string {
  const node = dag.getNode(hash);
  return node?.payload.kind === "evidence" ? node.payload.text : "";
}

function valueOf(dag: SoulDag, hash: Hash): ValuePayload {
  return dag.getNode(hash)!.payload as ValuePayload;
}

/** Median of a numeric array (0 for empty). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface ConsolidateOptions {
  readonly now: number;
  /** Override the adaptive threshold (mainly for tests). */
  readonly mergeThreshold?: number;
  /** Fraction of the median NN distance used as the adaptive threshold. */
  readonly adaptiveFactor?: number;
}

export interface ConsolidateResult {
  readonly created: Hash[];
  readonly superseded: Hash[];
  readonly groups: number;
  readonly threshold: number;
}

/**
 * Run one consolidation pass. Returns what merged. Caller commits.
 */
export async function consolidate(
  dag: SoulDag,
  embedder: Embedder,
  cfg: SoulConfig,
  opts: ConsolidateOptions,
): Promise<ConsolidateResult> {
  const values = liveValues(dag);
  if (values.length < 2) {
    return { created: [], superseded: [], groups: 0, threshold: 0 };
  }

  // Represent each value by its medoid embedding.
  const repTexts = values.map((h) => evidenceText(dag, valueOf(dag, h).medoid));
  const reps = await embedder.embed(repTexts);

  // Adaptive threshold: how close is "unusually close" for THIS lattice right now.
  const nn: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let best = Infinity;
    for (let j = 0; j < values.length; j++) {
      if (i === j) continue;
      best = Math.min(best, cosineDistance(reps[i]!, reps[j]!));
    }
    if (Number.isFinite(best)) nn.push(best);
  }
  const factor = opts.adaptiveFactor ?? 0.6;
  const threshold = opts.mergeThreshold ?? median(nn) * factor;

  // Connected components over the "close enough to merge" graph (union-find).
  const parent = values.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (cosineDistance(reps[i]!, reps[j]!) <= threshold) union(i, j);
    }
  }

  // Gather groups of size > 1.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < values.length; i++) {
    const root = find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(i);
  }

  const created: Hash[] = [];
  const superseded: Hash[] = [];

  for (const members of groups.values()) {
    if (members.length < 2) continue;

    const oldValues = members.map((i) => values[i]!);
    // Union of all member evidence across the merging values.
    const evidenceSet = new Set<Hash>();
    for (const v of oldValues) {
      const p = valueOf(dag, v);
      evidenceSet.add(p.medoid);
      for (const m of p.members) evidenceSet.add(m);
    }
    const evidence = [...evidenceSet].sort();

    // Recompute the medoid over the merged evidence — its new label emerges.
    const evTexts = evidence.map((h) => evidenceText(dag, h));
    const evVecs = await embedder.embed(evTexts);
    const medoid = evidence[medoidIndex(evVecs)]!;

    const merged = dag.addNode(
      { kind: "value", members: evidence, medoid },
      opts.now,
    );
    created.push(merged);

    // Migrate learned state forward: sum decayed salience + evidence + activations.
    const target = dag.stateOf(merged);
    for (const v of oldValues) {
      const s = dag.stateOf(v);
      target.salience += effectiveSalience(
        s,
        opts.now,
        halfLifeForKind(cfg, "value"),
      );
      target.evidence += s.evidence;
      target.activations += s.activations;
      const e = dag.edge(merged, "supersedes", v, opts.now);
      e.weight = 1;
      e.updatedAt = opts.now;
      if (v !== merged) superseded.push(v);
    }
    target.lastActivatedAt = opts.now;
    dag.touch(merged);
  }

  return { created, superseded, groups: created.length, threshold };
}
