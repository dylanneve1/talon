/**
 * Soul Kernel — hyperdimensional computing (Vector-Symbolic Architecture).
 *
 * Kanerva, "Hyperdimensional Computing" (2009). High-dimensional bipolar vectors
 * (±1, here a few thousand dims) support a small algebra that is the basis of a
 * compositional, model-free associative memory:
 *
 *   - bind (⊗)   elementwise product. Combines two hypervectors into one
 *                DISSIMILAR to both, and is its own inverse (bind twice by the
 *                same key recovers the other operand). Used to pair a role with a
 *                filler: context ⊗ value.
 *   - bundle (+) elementwise majority. Superposes many hypervectors into one
 *                SIMILAR to all of them — a set, or a memory of many episodes.
 *   - permute (ρ) cyclic shift. Encodes order/role without collision.
 *   - cleanup     nearest stored item under cosine — denoises a recalled vector
 *                back to a known symbol.
 *
 * The soul uses this for episodic recall: bind the current context to the value
 * that worked, bundle those bindings into one memory hypervector, and later query
 * "in a context like this, what do I do?" by unbinding and cleaning up. It is a
 * genuinely compositional memory, and it is pure integer arithmetic — no model.
 */

import { createHash } from "node:crypto";

export type Hypervector = Int8Array;

export const DEFAULT_HD_DIM = 4096;

/** Deterministic ±1 hypervector for a symbol — the same token always maps here. */
export function symbolVector(token: string, dim = DEFAULT_HD_DIM): Hypervector {
  const v = new Int8Array(dim);
  // Seed a tiny xorshift PRNG from the token hash; fill with ±1.
  const digest = createHash("sha256").update(token).digest();
  let s0 = digest.readUInt32LE(0) || 1;
  let s1 = digest.readUInt32LE(4) || 2;
  for (let i = 0; i < dim; i++) {
    // xorshift128-ish
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= x << 23;
    x ^= x >>> 17;
    x ^= y ^ (y >>> 26);
    s1 = x >>> 0;
    v[i] = ((s1 >>> (i % 31)) & 1) === 0 ? 1 : -1;
  }
  return v;
}

/** Elementwise bind (product). Self-inverse for bipolar vectors. */
export function bind(a: Hypervector, b: Hypervector): Hypervector {
  const out = new Int8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i]! * b[i]!) as number;
  return out;
}

/** Majority-rule bundle of several hypervectors; empty ⇒ zero vector. */
export function bundle(vectors: readonly Hypervector[]): Hypervector {
  const dim = vectors[0]?.length ?? DEFAULT_HD_DIM;
  const acc = new Int32Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i++) acc[i]! += v[i]!;
  const out = new Int8Array(dim);
  for (let i = 0; i < dim; i++) out[i] = acc[i]! >= 0 ? 1 : -1; // ties → +1
  return out;
}

/** Cyclic shift by k (encodes role/order). */
export function permute(v: Hypervector, k = 1): Hypervector {
  const dim = v.length;
  const out = new Int8Array(dim);
  const shift = ((k % dim) + dim) % dim;
  for (let i = 0; i < dim; i++) out[(i + shift) % dim] = v[i]!;
  return out;
}

/** Cosine similarity of two bipolar vectors (= normalized dot). */
export function hdCosine(a: Hypervector, b: Hypervector): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / a.length;
}

/** Nearest stored item to a (noisy) query, by cosine. */
export function cleanup(
  query: Hypervector,
  items: ReadonlyMap<string, Hypervector>,
): { token: string; score: number } | undefined {
  let best: { token: string; score: number } | undefined;
  for (const [token, v] of items) {
    const score = hdCosine(query, v);
    if (!best || score > best.score) best = { token, score };
  }
  return best;
}

/**
 * A compositional associative memory: a running superposition of role⊗filler
 * bindings. Querying with a role unbinds and returns a noisy filler to be cleaned
 * up against an item memory. Stored as an integer accumulator so many episodes
 * can be bundled without saturating.
 */
export class CompositionalMemory {
  private readonly acc: Int32Array;
  private count = 0;

  constructor(
    readonly dim = DEFAULT_HD_DIM,
    acc?: Int32Array,
    count = 0,
  ) {
    this.acc = acc ?? new Int32Array(dim);
    this.count = count;
  }

  /** Superpose one role⊗filler binding into the memory. */
  add(role: Hypervector, filler: Hypervector): void {
    const bound = bind(role, filler);
    for (let i = 0; i < this.dim; i++) this.acc[i]! += bound[i]!;
    this.count += 1;
  }

  /** The signed memory hypervector. */
  vector(): Hypervector {
    const out = new Int8Array(this.dim);
    for (let i = 0; i < this.dim; i++) out[i] = this.acc[i]! >= 0 ? 1 : -1;
    return out;
  }

  /** Unbind a role to recover the (noisy) filler it was paired with. */
  query(role: Hypervector): Hypervector {
    return bind(this.vector(), role);
  }

  get episodes(): number {
    return this.count;
  }

  snapshot(): { dim: number; acc: number[]; count: number } {
    return { dim: this.dim, acc: Array.from(this.acc), count: this.count };
  }

  static restore(snap: {
    dim: number;
    acc: number[];
    count: number;
  }): CompositionalMemory {
    return new CompositionalMemory(
      snap.dim,
      Int32Array.from(snap.acc),
      snap.count,
    );
  }
}
