/**
 * Tests for the embedder boundary and vector math. The HashingEmbedder is a
 * deterministic fixed function; these pin the geometry the clustering relies on.
 */

import { describe, expect, it } from "vitest";
import {
  HashingEmbedder,
  centroid,
  cosineDistance,
  cosineSimilarity,
  medoidIndex,
  normalize,
} from "../core/soul/embedder.js";

describe("vector math", () => {
  it("normalize yields unit length", () => {
    const v = normalize([3, 4]);
    expect(Math.hypot(...v)).toBeCloseTo(1, 10);
  });

  it("cosine similarity/distance are consistent", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosineDistance([1, 0], [1, 0])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("centroid averages then normalizes", () => {
    const c = centroid([
      [1, 0],
      [0, 1],
    ]);
    expect(Math.hypot(...c)).toBeCloseTo(1, 10);
    expect(c[0]).toBeCloseTo(c[1]!, 10);
  });

  it("medoidIndex finds the most central member", () => {
    // two tight points and one outlier; medoid is one of the tight pair
    const vs = [normalize([1, 0]), normalize([0.99, 0.01]), normalize([0, 1])];
    expect(medoidIndex(vs)).not.toBe(2);
  });
});

describe("HashingEmbedder", () => {
  it("is deterministic and unit-normalized", async () => {
    const e = new HashingEmbedder(128);
    const [a] = await e.embed(["verify before stating"]);
    const [b] = await e.embed(["verify before stating"]);
    expect(a).toEqual(b);
    expect(norm(a!)).toBeCloseTo(1, 6);
  });

  it("places lexically similar text nearer than unrelated text", async () => {
    const e = new HashingEmbedder(512);
    const [base, near, far] = await e.embed([
      "verify facts before stating them",
      "always verify facts before you state them",
      "send a funny sticker to the group chat",
    ]);
    const dNear = cosineDistance(base!, near!);
    const dFar = cosineDistance(base!, far!);
    expect(dNear).toBeLessThan(dFar);
  });
});

function norm(a: readonly number[]): number {
  return Math.sqrt(a.reduce((s, x) => s + x * x, 0));
}
