/**
 * Soul Kernel — reflection.
 *
 * Generative Agents (Park et al., 2023) defines reflection as synthesizing
 * memories into higher-level inferences over time. Here that synthesis is
 * STRUCTURAL and model-free: the soul forms a `theme` over a group of values that
 * are both semantically coherent AND frequently co-active. "Coherent and seen
 * together" is the mechanical signature of a higher-order trait.
 *
 * Affinity between two values blends two signals already in the kernel:
 *
 *   affinity(a,b) = w · cos(medoid_a, medoid_b) + (1−w) · normalizedCoactivation
 *
 * Connected components of the "affinity ≥ threshold" graph become themes. A
 * theme's label is its medoid (a real fragment), UNLESS an optional `synthesize`
 * callback is supplied — the single, gated place a model may write a natural
 * language insight. Critically, that callback can only LABEL; it can never change
 * which values are grouped, so the model can't drift identity structure.
 */

import { liveValues } from "./consolidate.js";
import type { SoulDag } from "./dag.js";
import { cosineSimilarity, medoidIndex, type Embedder } from "./embedder.js";
import { effectiveSalience } from "./salience.js";
import type { Hash, SoulConfig, ValuePayload } from "./types.js";
import { halfLifeForKind } from "./types.js";

export interface ReflectOptions {
  readonly now: number;
  /** Affinity threshold for grouping values into a theme (0..1). */
  readonly affinity?: number;
  /** Weight on the semantic term vs. the co-activation term (0..1). */
  readonly embeddingWeight?: number;
  /**
   * Optional gated model label synthesizer. Receives the theme's member
   * evidence (verbatim) and may return a short insight; returning undefined
   * keeps the medoid label. This is the only model touch in the entire kernel,
   * and it is label-only.
   */
  readonly synthesize?: (
    members: readonly { hash: Hash; text: string }[],
  ) => string | undefined;
}

export interface ReflectResult {
  readonly created: Hash[];
}

function medoidText(dag: SoulDag, valueHash: Hash): string {
  const v = dag.getNode(valueHash)?.payload as ValuePayload | undefined;
  if (!v) return "";
  const e = dag.getNode(v.medoid);
  return e?.payload.kind === "evidence" ? e.payload.text : "";
}

function memberEvidence(dag: SoulDag, valueHash: Hash): Hash[] {
  const v = dag.getNode(valueHash)?.payload as ValuePayload | undefined;
  if (!v) return [];
  return [v.medoid, ...v.members];
}

/**
 * Form themes over the value graph. Returns the theme hashes created. Caller
 * commits. Async because affinity embeds value medoids.
 */
export async function reflect(
  dag: SoulDag,
  embedder: Embedder,
  cfg: SoulConfig,
  opts: ReflectOptions,
): Promise<ReflectResult> {
  const threshold = opts.affinity ?? 0.5;
  const w = opts.embeddingWeight ?? 0.5;
  const values = liveValues(dag);
  if (values.length < 2) return { created: [] };

  const reps = await embedder.embed(values.map((h) => medoidText(dag, h)));

  // Normalizer for the co-activation term.
  let maxCo = 0;
  for (let i = 0; i < values.length; i++) {
    for (const e of dag.edgesFrom(values[i]!, "coactivation")) {
      maxCo = Math.max(maxCo, e.weight);
    }
  }
  const coWeight = (a: Hash, b: Hash): number => {
    if (maxCo === 0) return 0;
    const e = dag.getEdge(a, "coactivation", b);
    return e ? e.weight / maxCo : 0;
  };

  // Union-find over affinity edges.
  const parent = values.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const sim = Math.max(0, cosineSimilarity(reps[i]!, reps[j]!));
      const affinity = w * sim + (1 - w) * coWeight(values[i]!, values[j]!);
      if (affinity >= threshold) parent[find(i)] = find(j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < values.length; i++) {
    const r = find(i);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(i);
  }

  const created: Hash[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const members = idxs.map((i) => values[i]!).sort();

    // Medoid over all evidence across the member values.
    const evidence = [
      ...new Set(members.flatMap((v) => memberEvidence(dag, v))),
    ];
    const evVecs = await embedder.embed(
      evidence.map((h) => {
        const e = dag.getNode(h);
        return e?.payload.kind === "evidence" ? e.payload.text : "";
      }),
    );
    const medoid = evidence[medoidIndex(evVecs)]!;

    const insight = opts.synthesize?.(
      evidence.map((h) => ({
        hash: h,
        text:
          dag.getNode(h)?.payload.kind === "evidence"
            ? (dag.getNode(h)!.payload as { text: string }).text
            : "",
      })),
    );

    const theme = dag.addNode(
      {
        kind: "theme",
        values: members,
        medoid,
        ...(insight ? { insight } : {}),
      },
      opts.now,
    );
    created.push(theme);

    // Theme salience aggregates its members so it can be ranked/projected.
    const st = dag.stateOf(theme);
    st.salience = members.reduce(
      (s, v) =>
        s +
        effectiveSalience(
          dag.stateOf(v),
          opts.now,
          halfLifeForKind(cfg, "value"),
        ),
      0,
    );
    st.lastActivatedAt = opts.now;
    dag.touch(theme);
  }

  return { created };
}
