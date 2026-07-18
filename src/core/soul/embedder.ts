/**
 * Soul Kernel — the embedder boundary and the vector math.
 *
 * The embedder is the ONLY neural component the kernel may touch, and it is a
 * frozen fixed function, not a reasoning agent — so it stays inside the
 * model-free principle. It is injected: production wires MemPalace's local
 * embedding model; tests and offline operation use the deterministic
 * `HashingEmbedder` below.
 *
 * Everything the kernel does *with* embeddings — clustering evidence into values,
 * picking a medoid label, measuring contradiction/drift — is plain vector
 * arithmetic implemented here. No model decides what relates to what; geometry
 * does.
 */

import { createHash } from "node:crypto";

/** A pluggable text→vector function. Vectors should be L2-normalized. */
export interface Embedder {
  readonly dim: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

// ── Vector math ──────────────────────────────────────────────────────────────

export function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a));
}

/** L2-normalize a vector; a zero vector is returned unchanged. */
export function normalize(a: readonly number[]): number[] {
  const n = norm(a);
  if (n === 0) return [...a];
  return a.map((x) => x / n);
}

/** Cosine similarity in [-1, 1] (assumes finite inputs). */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/** Cosine distance in [0, 2]. 0 = identical direction. */
export function cosineDistance(
  a: readonly number[],
  b: readonly number[],
): number {
  return 1 - cosineSimilarity(a, b);
}

/** Mean vector of a set, L2-normalized. The cluster centroid. */
export function centroid(vectors: readonly (readonly number[])[]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const acc = Array.from({ length: dim }, () => 0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) acc[i]! += v[i]!;
  }
  for (let i = 0; i < dim; i++) acc[i]! /= vectors.length;
  return normalize(acc);
}

/**
 * Index of the medoid: the member with minimum total cosine distance to all
 * others — the single most central *real* item. This is what labels a value:
 * never generated prose, always a genuine fragment.
 */
export function medoidIndex(vectors: readonly (readonly number[])[]): number {
  if (vectors.length === 0) return -1;
  let best = 0;
  let bestSum = Infinity;
  for (let i = 0; i < vectors.length; i++) {
    let sum = 0;
    for (let j = 0; j < vectors.length; j++) {
      if (i !== j) sum += cosineDistance(vectors[i]!, vectors[j]!);
    }
    if (sum < bestSum) {
      bestSum = sum;
      best = i;
    }
  }
  return best;
}

// ── Deterministic offline embedder ───────────────────────────────────────────

/**
 * A frozen, dependency-free embedder via feature hashing over character n-grams
 * and word tokens. Deterministic and model-free: similar strings share n-grams
 * and therefore land near each other in cosine space. Crude next to a real
 * sentence encoder, but it is a genuine fixed function — suitable for tests,
 * offline operation, and as a fallback when the local model is unavailable.
 */
export class HashingEmbedder implements Embedder {
  constructor(readonly dim = 256) {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = Array.from({ length: this.dim }, () => 0);
    const lower = text.toLowerCase();
    const add = (feature: string): void => {
      const h = createHash("md5").update(feature).digest();
      const idx = ((h[0]! << 8) | h[1]!) % this.dim;
      const sign = (h[2]! & 1) === 0 ? 1 : -1; // sign hashing reduces bias
      vec[idx]! += sign;
    };
    // word tokens
    for (const w of lower.split(/[^a-z0-9]+/).filter(Boolean)) add(`w:${w}`);
    // character 3-grams over the normalized stream
    const stream = lower.replace(/\s+/g, " ");
    for (let i = 0; i + 3 <= stream.length; i++)
      add(`g:${stream.slice(i, i + 3)}`);
    return normalize(vec);
  }
}
