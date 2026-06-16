/**
 * Soul Kernel — learned valence.
 *
 * Hardcoding "👍 = +1" is exactly the kind of over-programming the soul should
 * outgrow. What a cue *means* is not a constant — it is whatever outcome reliably
 * follows it. So valence is learned: when an interaction's downstream engagement
 * resolves (the conversation continued, or died), every categorical cue that
 * preceded it (the emoji used, say) is nudged toward that outcome. Over time the
 * model discovers, from Talon's own data, that 👍 tends to precede continuation
 * and 👎 tends to precede silence — or whatever is actually true here, which may
 * differ from the prior.
 *
 * A weak prior (the old static table) seeds cold-start so early behavior is
 * sane, but evidence overrides it: the effective valence is a count-weighted
 * blend that converges to the observed mean as observations accumulate.
 */

import { emojiValence } from "./signals.js";

interface CueStat {
  sum: number;
  count: number;
}

export interface ValenceSnapshot {
  readonly priorWeight: number;
  readonly stats: readonly (readonly [string, CueStat])[];
}

export class ValenceModel {
  private readonly stats = new Map<string, CueStat>();

  /**
   * @param prior       cold-start valence for an unseen cue (default: the old
   *                    emoji table — a fading prior, not a rule).
   * @param priorWeight pseudo-count for the prior; evidence dominates past it.
   */
  constructor(
    private readonly prior: (cue: string) => number = emojiValence,
    private readonly priorWeight = 2,
  ) {}

  /** Record that `cue` was followed by `outcome` (e.g. +1 continued, -1 died). */
  observe(cue: string, outcome: number): void {
    const s = this.stats.get(cue) ?? { sum: 0, count: 0 };
    s.sum += outcome;
    s.count += 1;
    this.stats.set(cue, s);
  }

  /**
   * Effective learned valence: a count-weighted blend of the prior and the
   * observed mean. With no observations it equals the prior; as observations
   * accumulate it converges to sum/count.
   */
  valence(cue: string): number {
    const s = this.stats.get(cue);
    const p = this.prior(cue);
    if (!s || s.count === 0) return p;
    return (this.priorWeight * p + s.sum) / (this.priorWeight + s.count);
  }

  /** How much evidence backs a cue (0 = pure prior). */
  confidence(cue: string): number {
    return this.stats.get(cue)?.count ?? 0;
  }

  snapshot(): ValenceSnapshot {
    return {
      priorWeight: this.priorWeight,
      stats: [...this.stats.entries()].map(([k, v]) => [k, { ...v }]),
    };
  }

  static restore(
    snap: ValenceSnapshot,
    prior: (cue: string) => number = emojiValence,
  ): ValenceModel {
    const model = new ValenceModel(prior, snap.priorWeight);
    for (const [cue, stat] of snap.stats) model.stats.set(cue, { ...stat });
    return model;
  }
}
