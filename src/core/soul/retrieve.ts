/**
 * Soul Kernel — context-conditioned retrieval.
 *
 * Grounded in Park et al., "Generative Agents: Interactive Simulacra of Human
 * Behavior" (2023), whose memory retrieval scores each record by a normalized
 * sum of three signals: recency, importance, and relevance to the current
 * moment. We adapt it to value retrieval so the projected soul is the part of
 * identity that is *relevant right now*, not just globally salient:
 *
 *   recency     — decayed salience (already the kernel's "weather").
 *   importance  — how core the value is: confidence magnitude + how connected it
 *                 is in the Hebbian lattice (degree centrality). Central,
 *                 well-evidenced values matter regardless of the moment.
 *   relevance   — cosine similarity between the value's medoid and the current
 *                 context embedding (0 when no context is supplied).
 *
 * Each component is min-max normalized to [0,1] across the candidate set (as in
 * the paper) before the weighted sum, so no single signal's scale dominates.
 * Still model-free: scores are arithmetic over embeddings and counts.
 */

import type { SoulDag } from "./dag.js";
import { isSuperseded } from "./consolidate.js";
import { cosineSimilarity, type Embedder } from "./embedder.js";
import { confidence, effectiveSalience } from "./salience.js";
import type { Hash, SoulConfig, ValuePayload } from "./types.js";
import { halfLifeForKind } from "./types.js";

export interface RetrievalWeights {
  readonly recency: number;
  readonly importance: number;
  readonly relevance: number;
}

export const DEFAULT_RETRIEVAL_WEIGHTS: RetrievalWeights = {
  recency: 1,
  importance: 1,
  relevance: 1,
};

export interface RetrievedValue {
  readonly hash: Hash;
  readonly score: number;
  readonly recency: number;
  readonly importance: number;
  readonly relevance: number;
}

export interface RetrieveOptions {
  readonly now: number;
  readonly config: SoulConfig;
  /** Current-moment text; its embedding drives the relevance term. */
  readonly context?: string;
  readonly weights?: RetrievalWeights;
  /**
   * Optional precomputed centrality (e.g. PageRank) used for the importance
   * term. When absent, importance falls back to log-degree centrality.
   */
  readonly centrality?: ReadonlyMap<Hash, number>;
}

function medoidText(dag: SoulDag, valueHash: Hash): string | undefined {
  const node = dag.getNode(valueHash);
  if (node?.payload.kind !== "value") return undefined;
  const medoid = dag.getNode((node.payload as ValuePayload).medoid);
  return medoid?.payload.kind === "evidence" ? medoid.payload.text : undefined;
}

/** Degree centrality: total coactivation edge weight incident to a node. */
function centrality(dag: SoulDag, hash: Hash): number {
  let sum = 0;
  for (const e of dag.edgesFrom(hash, "coactivation")) sum += e.weight;
  return sum;
}

function minMax(values: number[]): (x: number) => number {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  return (x) => (span <= 0 ? 0 : (x - lo) / span);
}

/**
 * Rank live values by the Generative-Agents composite score. Async because the
 * relevance term embeds the medoids and the context together.
 */
export async function retrieveValues(
  dag: SoulDag,
  embedder: Embedder,
  opts: RetrieveOptions,
): Promise<RetrievedValue[]> {
  const weights = opts.weights ?? DEFAULT_RETRIEVAL_WEIGHTS;
  const values = dag
    .nodesOfKind("value")
    .filter((n) => !isSuperseded(dag, n.hash));

  const rows = values
    .map((n) => ({ hash: n.hash, text: medoidText(dag, n.hash) }))
    .filter((r): r is { hash: Hash; text: string } => !!r.text);
  if (rows.length === 0) return [];

  const rawRecency = rows.map((r) =>
    effectiveSalience(
      dag.stateOf(r.hash),
      opts.now,
      halfLifeForKind(opts.config, "value"),
    ),
  );
  const rawImportance = rows.map((r) => {
    const conf = Math.abs(confidence(dag.stateOf(r.hash)));
    const struct = opts.centrality
      ? (opts.centrality.get(r.hash) ?? 0)
      : Math.log1p(centrality(dag, r.hash));
    return conf + struct;
  });

  // Relevance via one embed call over [context, ...medoids].
  let rawRelevance = rows.map(() => 0);
  if (opts.context) {
    const vecs = await embedder.embed([
      opts.context,
      ...rows.map((r) => r.text),
    ]);
    const ctx = vecs[0]!;
    rawRelevance = rows.map((_, i) =>
      Math.max(0, cosineSimilarity(ctx, vecs[i + 1]!)),
    );
  }

  const nR = minMax(rawRecency);
  const nI = minMax(rawImportance);
  const nV = minMax(rawRelevance);

  return rows
    .map((r, i) => {
      const recency = nR(rawRecency[i]!);
      const importance = nI(rawImportance[i]!);
      const relevance = nV(rawRelevance[i]!);
      const score =
        weights.recency * recency +
        weights.importance * importance +
        weights.relevance * relevance;
      return { hash: r.hash, score, recency, importance, relevance };
    })
    .sort((a, b) => b.score - a.score || a.hash.localeCompare(b.hash));
}
