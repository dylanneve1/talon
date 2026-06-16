/**
 * Soul Kernel — associative recall (modern Hopfield / attention).
 *
 * Grounded in Ramsauer et al., "Hopfield Networks is All You Need" (2020), which
 * showed that a continuous modern Hopfield network retrieves a stored pattern in
 * ONE update via a softmax over similarities — the very operation at the heart of
 * attention. We apply the same rule to the lattice: the Hebbian coactivation
 * edges are the stored associations, and recalling from a cue is a one-step
 * softmax over the edge weights.
 *
 *   p(neighbor) ∝ exp(β · w(cue → neighbor))
 *
 * `prime` then performs the Hopfield update against the lattice itself: it nudges
 * the salience of the associatively-bound partners. The behavioral effect is what
 * you would want from a self — thinking of one value brings its companions to
 * mind ("push back" primes "be direct"), so the soul recalls in coherent
 * constellations rather than isolated points. Still model-free: a softmax over
 * counts.
 */

import type { SoulDag } from "./dag.js";
import type { Hash } from "./types.js";

export interface RecallResult {
  readonly node: Hash;
  /** Softmax weight in (0, 1]; the constellation sums to 1. */
  readonly weight: number;
}

export interface RecallOptions {
  /** Inverse temperature; higher β sharpens recall toward the strongest bond. */
  readonly beta?: number;
  /** Keep only the top-K partners (default: all). */
  readonly topK?: number;
}

/**
 * One-step associative retrieval from one or more cue nodes. Aggregates
 * coactivation edge weights to each neighbor, then softmaxes. Cues are excluded
 * from their own recall.
 */
export function associativeRecall(
  dag: SoulDag,
  cues: readonly Hash[],
  opts: RecallOptions = {},
): RecallResult[] {
  const beta = opts.beta ?? 1;
  const cueSet = new Set(cues);
  const score = new Map<Hash, number>();
  for (const cue of cues) {
    for (const e of dag.edgesFrom(cue, "coactivation")) {
      if (cueSet.has(e.to)) continue;
      score.set(e.to, (score.get(e.to) ?? 0) + e.weight);
    }
  }
  if (score.size === 0) return [];

  // Numerically-stable softmax over β·score.
  const entries = [...score.entries()];
  const max = Math.max(...entries.map(([, w]) => w));
  const exps = entries.map(
    ([h, w]) => [h, Math.exp(beta * (w - max))] as const,
  );
  const z = exps.reduce((s, [, e]) => s + e, 0);

  const out = exps
    .map(([node, e]) => ({ node, weight: e / z }))
    .sort((a, b) => b.weight - a.weight || a.node.localeCompare(b.node));
  return opts.topK ? out.slice(0, opts.topK) : out;
}

export interface PrimeOptions extends RecallOptions {
  readonly now: number;
  /** Salience injected, distributed across the recalled constellation. */
  readonly gain: number;
}

/**
 * The Hopfield update applied to the lattice: recall from the cues and add
 * salience to the bound partners in proportion to their recall weight. Returns
 * the primed nodes. Caller commits.
 */
export function prime(
  dag: SoulDag,
  cues: readonly Hash[],
  opts: PrimeOptions,
): Hash[] {
  const recalled = associativeRecall(dag, cues, opts);
  const primed: Hash[] = [];
  for (const { node, weight } of recalled) {
    const s = dag.stateOf(node);
    s.salience += opts.gain * weight;
    s.lastActivatedAt = opts.now;
    dag.touch(node);
    primed.push(node);
  }
  return primed;
}
