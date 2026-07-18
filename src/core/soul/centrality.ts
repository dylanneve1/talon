/**
 * Soul Kernel — graph centrality (Personalized PageRank).
 *
 * Degree centrality ("how many strong bonds does this value have") is a crude
 * importance signal. PageRank (Page, Brin, Motwani & Winograd, 1999) is the
 * principled one: a value is important if it is bonded to OTHER important values.
 * We run it over the Hebbian co-activation graph so structural importance
 * reflects the whole association network, not just local degree.
 *
 * The "personalized" variant biases the teleport distribution toward a set of
 * seed nodes, yielding importance *relative to a context* — central with respect
 * to whatever is currently active. Pure power iteration; model-free.
 */

import type { SoulDag } from "./dag.js";
import type { Hash } from "./types.js";

export interface PageRankOptions {
  readonly damping?: number;
  readonly iterations?: number;
  readonly epsilon?: number;
  /**
   * Optional personalization: teleport mass distribution over nodes. Values are
   * normalized internally. Absent ⇒ uniform (classic PageRank).
   */
  readonly personalization?: ReadonlyMap<Hash, number>;
}

/**
 * Weighted Personalized PageRank over the value co-activation graph. Returns a
 * score per live value summing to 1. Dangling nodes (no outbound bonds)
 * redistribute their mass via the teleport vector, keeping it a proper
 * distribution.
 */
export function pagerank(
  dag: SoulDag,
  opts: PageRankOptions = {},
): Map<Hash, number> {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 100;
  const epsilon = opts.epsilon ?? 1e-9;

  const nodes = dag.nodesOfKind("value").map((n) => n.hash);
  const n = nodes.length;
  const out = new Map<Hash, number>();
  if (n === 0) return out;

  const idx = new Map(nodes.map((h, i) => [h, i]));

  // Weighted out-adjacency over coactivation edges (only among value nodes).
  const outWeight = Array.from({ length: n }, () => 0);
  const edges: { from: number; to: number; w: number }[] = [];
  for (const from of nodes) {
    for (const e of dag.edgesFrom(from, "coactivation")) {
      const j = idx.get(e.to);
      if (j === undefined || e.weight <= 0) continue;
      const i = idx.get(from)!;
      edges.push({ from: i, to: j, w: e.weight });
      outWeight[i]! += e.weight;
    }
  }

  // Teleport / personalization vector.
  const teleport = Array.from({ length: n }, () => 1 / n);
  if (opts.personalization && opts.personalization.size > 0) {
    let total = 0;
    for (const [, w] of opts.personalization) total += Math.max(0, w);
    if (total > 0) {
      for (let i = 0; i < n; i++) teleport[i] = 0;
      for (const [h, w] of opts.personalization) {
        const i = idx.get(h);
        if (i !== undefined) teleport[i]! += Math.max(0, w) / total;
      }
    }
  }

  let rank = Array.from({ length: n }, () => 1 / n);
  for (let it = 0; it < iterations; it++) {
    const next = teleport.map((t) => (1 - damping) * t);

    // Dangling mass (nodes with no out-edges) flows to the teleport vector.
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outWeight[i] === 0) dangling += rank[i]!;
    for (let i = 0; i < n; i++) next[i]! += damping * dangling * teleport[i]!;

    for (const e of edges) {
      next[e.to]! += (damping * rank[e.from]! * e.w) / outWeight[e.from]!;
    }

    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i]! - rank[i]!);
    rank = next;
    if (delta < epsilon) break;
  }

  for (let i = 0; i < n; i++) out.set(nodes[i]!, rank[i]!);
  return out;
}
