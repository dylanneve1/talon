/**
 * Soul Kernel — adaptive forgetting (FSRS / DSR-inspired).
 *
 * Fixed-half-life exponential decay treats a trait recalled a hundred times the
 * same as one recalled once. Human memory does not work that way, and neither
 * should the soul. This module implements a Difficulty-Stability-Retrievability
 * style model (Wozniak's DSR; the basis of FSRS, the algorithm modern Anki uses),
 * adapted to continuous time:
 *
 *   - Each node carries a STABILITY S (a time constant). Retrievability follows a
 *     POWER LAW, R(t) = (1 + FACTOR·t/S)^DECAY, which fits human forgetting far
 *     better than an exponential (Wickelgren; FSRS). At t = S, R ≈ 0.9.
 *   - Successful recall GROWS stability, and grows it MORE when the recall
 *     happened at low retrievability (the spacing effect) — so a trait that keeps
 *     proving itself across time becomes durable. A correction (negative valence)
 *     SHRINKS stability, so a discredited trait becomes easy to forget.
 *
 * The effective strength used for projection is salience × retrievability. The
 * net effect: core identity persists, fads evaporate — emergently, from the
 * timing and outcome of activations, not a hand-set constant.
 */

import type { ActivationState, SoulConfig } from "./types.js";

// FSRS power-law constants: R = (1 + FACTOR·t/S)^DECAY, with R(S) ≈ 0.9.
const DECAY = -0.5;
const FACTOR = 19 / 81;

const MIN_STABILITY = 1; // never let a node become un-forgettable-fast to 0
const GROWTH = 2.0; // spacing-effect stability gain scale
const LAPSE = 0.5; // stability multiplier on a correction

/** Power-law retrievability in (0, 1]. */
export function retrievability(elapsedMs: number, stability: number): number {
  if (elapsedMs <= 0) return 1;
  const s = Math.max(MIN_STABILITY, stability);
  return Math.pow(1 + (FACTOR * elapsedMs) / s, DECAY);
}

/** Initial stability for a node's first exposure. */
export function initialStability(cfg: SoulConfig): number {
  return cfg.decayHalfLifeMs;
}

/**
 * Stability after a recall. Positive valence grows it (more when retrievability
 * was low — the spacing effect); negative valence (a correction) shrinks it.
 */
export function nextStability(
  stability: number,
  r: number,
  valence: number,
): number {
  const s = Math.max(MIN_STABILITY, stability);
  if (valence < 0) return Math.max(MIN_STABILITY, s * LAPSE);
  // grow more when r is low (recall that "shouldn't" have succeeded teaches most)
  const gain = 1 + GROWTH * (1 - r) * Math.max(0.25, Math.min(1, valence));
  return s * gain;
}

/**
 * Salience after lazy power-law decay to `now`, using the node's stability when
 * present. Falls back to the caller's exponential decay when stability is unset.
 */
export function effectiveStrength(
  state: ActivationState,
  now: number,
  cfg: SoulConfig,
): number {
  if (state.stability === undefined) {
    // exponential fallback (mirrors salience.effectiveSalience)
    const f = Math.pow(
      0.5,
      Math.max(0, now - state.lastActivatedAt) / cfg.decayHalfLifeMs,
    );
    return state.salience * f;
  }
  return (
    state.salience *
    retrievability(now - state.lastActivatedAt, state.stability)
  );
}

export interface FsrsReinforceOpts {
  readonly now: number;
  readonly cfg: SoulConfig;
  readonly amount: number;
  readonly valence: number;
}

/**
 * Reinforcement under adaptive forgetting: decays salience by retrievability,
 * adds the increment, accumulates evidence, and updates stability per the
 * spacing/lapse rule. Mutates and returns the state.
 */
export function reinforceFsrs(
  state: ActivationState,
  opts: FsrsReinforceOpts,
): ActivationState {
  const stability = state.stability ?? initialStability(opts.cfg);
  const r = retrievability(opts.now - state.lastActivatedAt, stability);
  state.salience = state.salience * r + opts.amount;
  state.evidence += opts.valence;
  state.stability = nextStability(stability, r, opts.valence);
  state.activations += 1;
  state.lastActivatedAt = opts.now;
  return state;
}
