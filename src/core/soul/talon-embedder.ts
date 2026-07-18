/**
 * Soul Kernel — Talon's own embedder.
 *
 * We own this rather than borrowing MemPalace's: the soul should not depend on
 * another subsystem's model lifecycle, and identity geometry deserves a fixed,
 * versioned function we control. It is deterministic, dependency-free, and
 * model-free — a strong lexical encoder, not a neural one — so it can run
 * anywhere, forever, without weights or a runtime.
 *
 * Construction (richer than plain n-gram hashing):
 *   - word unigrams and bigrams capture phrasing,
 *   - character 3/4/5-grams capture morphology and typos (paraphrase robustness),
 *   - sublinear term weighting (1 + log count) damps repetition,
 *   - signed feature hashing into a wide space limits collision bias,
 *   - L2 normalization makes cosine the natural metric.
 *
 * The Embedder interface is the seam: if we ever want a real sentence-transformer
 * (e.g. ONNX, local), it drops in behind the same interface with zero changes
 * upstream. Until then, this is the canonical embedder for the kernel.
 */

import { createHash } from "node:crypto";
import { normalize, type Embedder } from "./embedder.js";

const TOKEN_RE = /[a-z0-9]+/g;

export interface TalonEmbedderOptions {
  readonly dim?: number;
  readonly charNgrams?: readonly number[];
  readonly wordBigrams?: boolean;
}

export class TalonEmbedder implements Embedder {
  readonly dim: number;
  private readonly charNgrams: readonly number[];
  private readonly wordBigrams: boolean;

  constructor(opts: TalonEmbedderOptions = {}) {
    this.dim = opts.dim ?? 1024;
    this.charNgrams = opts.charNgrams ?? [3, 4, 5];
    this.wordBigrams = opts.wordBigrams ?? true;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  /** Synchronous single-text embedding — handy for internal hot paths. */
  embedOne(text: string): number[] {
    const counts = new Map<string, number>();
    const bump = (feature: string): void => {
      counts.set(feature, (counts.get(feature) ?? 0) + 1);
    };

    const lower = text.toLowerCase();
    const words = lower.match(TOKEN_RE) ?? [];
    for (const w of words) bump(`w:${w}`);
    if (this.wordBigrams) {
      for (let i = 0; i + 1 < words.length; i++) {
        bump(`b:${words[i]}_${words[i + 1]}`);
      }
    }
    const stream = ` ${words.join(" ")} `;
    for (const n of this.charNgrams) {
      for (let i = 0; i + n <= stream.length; i++) {
        bump(`c${n}:${stream.slice(i, i + n)}`);
      }
    }

    const vec = Array.from({ length: this.dim }, () => 0);
    for (const [feature, count] of counts) {
      const h = createHash("md5").update(feature).digest();
      const idx = ((h[0]! << 16) | (h[1]! << 8) | h[2]!) % this.dim;
      const sign = (h[3]! & 1) === 0 ? 1 : -1;
      const weight = 1 + Math.log(count); // sublinear term weighting
      vec[idx]! += sign * weight;
    }
    return normalize(vec);
  }
}
