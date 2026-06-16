/**
 * Soul Kernel — lattice tension detection.
 *
 * The Lattice is identity as a graph of values, and its most distinctive feature
 * is that opposed values are held in *tension* rather than averaged away
 * ("concise ⟷ thorough", "push back ⟷ loyal"). A tension is not authored — it is
 * detected, mechanically, from two mechanical facts already in the kernel:
 *
 *   - the two values FIRE TOGETHER often (a strong Hebbian coactivation edge), yet
 *   - they are SEMANTICALLY FAR APART (large cosine distance between medoids).
 *
 * A pair that is both frequently co-active and far apart is, by definition, a
 * tension the self has to navigate. Geometry plus counting; no model judgement.
 */

import type { SoulDag } from "./dag.js";
import { isSuperseded } from "./consolidate.js";
import { cosineDistance, type Embedder } from "./embedder.js";
import type { AssocEdge, Hash, ValuePayload } from "./types.js";

export interface TensionOptions {
  /** Minimum coactivation weight for a pair to be considered. */
  readonly minCoactivation: number;
  /** Minimum cosine distance between medoids to count as opposed. */
  readonly minDistance: number;
  readonly now: number;
}

/** Resolve a value node's medoid text, for embedding. */
function medoidText(dag: SoulDag, valueHash: Hash): string | undefined {
  const node = dag.getNode(valueHash);
  if (node?.payload.kind !== "value") return undefined;
  const medoid = dag.getNode((node.payload as ValuePayload).medoid);
  return medoid?.payload.kind === "evidence" ? medoid.payload.text : undefined;
}

/**
 * Detect tension edges across the value graph and write them into the DAG.
 * Returns the tension edges created or updated. Symmetric: both directions are
 * recorded so either value surfaces the tension.
 */
export async function detectTensions(
  dag: SoulDag,
  embedder: Embedder,
  opts: TensionOptions,
): Promise<AssocEdge[]> {
  const values = dag.nodesOfKind("value");
  const texts: string[] = [];
  const hashes: Hash[] = [];
  for (const v of values) {
    if (isSuperseded(dag, v.hash)) continue;
    const text = medoidText(dag, v.hash);
    if (text) {
      texts.push(text);
      hashes.push(v.hash);
    }
  }
  if (hashes.length < 2) return [];

  const vectors = await embedder.embed(texts);
  const index = new Map(hashes.map((h, i) => [h, vectors[i]!]));
  const created: AssocEdge[] = [];

  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      const a = hashes[i]!;
      const b = hashes[j]!;
      const co = dag.getEdge(a, "coactivation", b);
      if (!co || co.weight < opts.minCoactivation) continue;

      const dist = cosineDistance(index.get(a)!, index.get(b)!);
      if (dist < opts.minDistance) continue;

      // Weight the tension by how strongly the pair both co-fires and diverges.
      const weight = co.weight * dist;
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        const e = dag.edge(from, "tension", to, opts.now);
        e.weight = weight;
        e.updatedAt = opts.now;
        created.push(e);
      }
    }
  }
  return created;
}

/** Unique tension pairs (deduped across symmetric edges), strongest first. */
export function tensionPairs(
  dag: SoulDag,
): { a: Hash; b: Hash; weight: number }[] {
  const seen = new Set<string>();
  const pairs: { a: Hash; b: Hash; weight: number }[] = [];
  for (const e of dag.allEdges("tension")) {
    const key = [e.from, e.to].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ a: e.from, b: e.to, weight: e.weight });
  }
  return pairs.sort((x, y) => y.weight - x.weight);
}
