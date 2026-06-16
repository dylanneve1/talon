/**
 * Soul Kernel — concept-drift detection (ADWIN).
 *
 * Bifet & Gavaldà, "Learning from Time-Changing Data with Adaptive Windowing"
 * (2007). ADWIN keeps a window of recent observations and, whenever the means of
 * an older and a newer sub-window differ beyond a variance-aware Hoeffding bound,
 * declares a change and forgets the stale older half. It needs no fixed window
 * size — the window adapts to how stationary the stream is.
 *
 * The soul feeds it the scalar outcome of interactions (the valence of what
 * happens). A detected change is a genuine shift in how Talon's behavior is
 * landing — a developmental inflection — which the kernel records as an epoch in
 * the Spine. Pure statistics; model-free.
 *
 * This is the readable ADWIN0 variant (exhaustive cut search over a flat window)
 * rather than the bucketed/exponential-histogram optimization, which is faithful
 * to the test and bound but O(n) per insert — fine at the soul's data rate.
 */

export interface AdwinChange {
  /** True on the insert that triggered a change. */
  readonly changed: boolean;
  /** Mean before the cut (the era being forgotten), when changed. */
  readonly meanBefore?: number;
  /** Mean after the cut (the new era), when changed. */
  readonly meanAfter?: number;
}

export class Adwin {
  private window: number[] = [];

  /** @param delta confidence; smaller = fewer false alarms (default 0.002). */
  constructor(private readonly delta = 0.002) {}

  get width(): number {
    return this.window.length;
  }

  get total(): number {
    return this.window.reduce((s, x) => s + x, 0);
  }

  get mean(): number {
    return this.window.length ? this.total / this.window.length : 0;
  }

  private static stats(xs: number[]): { mean: number; variance: number } {
    const n = xs.length;
    if (n === 0) return { mean: 0, variance: 0 };
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
    return { mean, variance };
  }

  /**
   * Add an observation. Searches every split; if a split's sub-window means
   * differ beyond the variance-aware Hoeffding bound, drops the older half and
   * reports the change.
   */
  add(value: number): AdwinChange {
    this.window.push(value);
    const n = this.window.length;
    if (n < 2) return { changed: false };

    const wholeVar = Adwin.stats(this.window).variance;

    for (let cut = 1; cut < n; cut++) {
      const left = this.window.slice(0, cut);
      const right = this.window.slice(cut);
      const n0 = left.length;
      const n1 = right.length;
      const m0 = left.reduce((s, x) => s + x, 0) / n0;
      const m1 = right.reduce((s, x) => s + x, 0) / n1;

      // Harmonic window size and the ADWIN variance-aware bound.
      const m = 1 / (1 / n0 + 1 / n1);
      const deltaPrime = this.delta / n;
      const eps =
        Math.sqrt((2 / m) * wholeVar * Math.log(2 / deltaPrime)) +
        (2 / (3 * m)) * Math.log(2 / deltaPrime);

      if (Math.abs(m0 - m1) > eps) {
        this.window = right; // forget the stale older era
        return { changed: true, meanBefore: m0, meanAfter: m1 };
      }
    }
    return { changed: false };
  }

  snapshot(): readonly number[] {
    return [...this.window];
  }

  static restore(window: readonly number[], delta = 0.002): Adwin {
    const a = new Adwin(delta);
    a.window = [...window];
    return a;
  }
}
