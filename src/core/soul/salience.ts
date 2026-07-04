/**
 * Soul Kernel — salience dynamics. "The soul has weather."
 *
 * This is the entire learning mechanism, and it is pure arithmetic — no model,
 * no embedder, just counters, exponential decay, and a delta rule. Four forces:
 *
 *   - decay        salience halves over a half-life of disuse, so stale
 *                  fixations fade from projection without being deleted.
 *   - reinforce    activation under a positive signal raises salience and
 *                  accumulates signed evidence.
 *   - coactivate   Hebbian: nodes that fire together in a successful interaction
 *                  strengthen their mutual edge ("fire together, wire together").
 *   - prediction   the soul predicts how loud a node should be; a correction is
 *     error        a large prediction error and updates proportionally.
 *
 * Decay is applied LAZILY: stored salience is always "salience as of
 * lastActivatedAt", and the effective value at any later instant is computed on
 * read. This means no global sweep is ever required — reading the soul is O(1)
 * per node, and writing only touches the nodes actually involved.
 */

import type { SoulDag } from "./dag.js";
import { retrievability } from "./forgetting.js";
import type { ActivationState, Hash } from "./types.js";

/** Exponential decay multiplier for an elapsed interval given a half-life. */
export function decayFactor(elapsedMs: number, halfLifeMs: number): number {
  if (elapsedMs <= 0 || halfLifeMs <= 0) return elapsedMs <= 0 ? 1 : 0;
  return Math.pow(0.5, elapsedMs / halfLifeMs);
}

/**
 * Salience as it stands *now*, after lazy time-decay from its last activation.
 * When the node carries an FSRS stability, decay follows the power-law
 * retrievability curve; otherwise it is the fixed-half-life exponential. An
 * infinite half-life (a no-decay node kind, e.g. reflexes) short-circuits both
 * paths: the stored salience is returned untouched.
 */
export function effectiveSalience(
  state: ActivationState,
  now: number,
  halfLifeMs: number,
): number {
  if (!Number.isFinite(halfLifeMs)) return state.salience;
  if (state.stability !== undefined) {
    return (
      state.salience *
      retrievability(now - state.lastActivatedAt, state.stability)
    );
  }
  return state.salience * decayFactor(now - state.lastActivatedAt, halfLifeMs);
}

/**
 * Confidence in a node, squashed from its net evidence into (-1, 1). Positive
 * means behavior expressing it has been rewarded; negative means corrected.
 * tanh keeps a runaway counter from ever dominating.
 */
export function confidence(state: ActivationState): number {
  return Math.tanh(state.evidence / 4);
}

export interface ReinforceOpts {
  readonly now: number;
  readonly halfLifeMs: number;
  /** Salience increment for this activation (>= 0). */
  readonly amount: number;
  /** Signed evidence delta: positive for reward, negative for a correction. */
  readonly valence: number;
}

/**
 * Activation under a behavioral signal. Decays the stored salience to `now`
 * first (so the additive bump composes correctly with time), then adds the
 * increment and accumulates signed evidence.
 */
export function reinforce(dag: SoulDag, hash: Hash, opts: ReinforceOpts): void {
  const s = dag.stateOf(hash);
  s.salience = effectiveSalience(s, opts.now, opts.halfLifeMs) + opts.amount;
  s.evidence += opts.valence;
  s.activations += 1;
  s.lastActivatedAt = opts.now;
  dag.touch(hash);
}

/**
 * Hebbian co-activation over the set of nodes active in one interaction.
 * Strengthens a symmetric coactivation edge for every unordered pair. The
 * Lattice's affinity/tension structure self-organizes from these counts — no
 * model decides which values relate, the statistics do.
 */
export function coactivate(
  dag: SoulDag,
  hashes: readonly Hash[],
  opts: { now: number; increment: number },
): void {
  const list = [...new Set(hashes)];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        const e = dag.edge(from, "coactivation", to, opts.now);
        e.weight += opts.increment;
        e.updatedAt = opts.now;
      }
    }
  }
}

export interface PredictionErrorOpts {
  readonly now: number;
  readonly halfLifeMs: number;
  /** How strongly the observed signal corrects the prediction, in (0, 1]. */
  readonly learningRate: number;
}

/**
 * Predictive-coding update. The soul holds a prediction of how salient a node
 * should be (its decayed salience); the realized `observed` signal yields an
 * error, and salience moves a learningRate-fraction of the way toward it.
 * Returns the error so callers can route large surprises into the Spine as
 * developmental events. Salience is floored at 0.
 */
export function applyPredictionError(
  dag: SoulDag,
  hash: Hash,
  observed: number,
  opts: PredictionErrorOpts,
): number {
  const s = dag.stateOf(hash);
  const predicted = effectiveSalience(s, opts.now, opts.halfLifeMs);
  const error = observed - predicted;
  s.salience = Math.max(0, predicted + opts.learningRate * error);
  s.activations += 1;
  s.lastActivatedAt = opts.now;
  dag.touch(hash);
  return error;
}
