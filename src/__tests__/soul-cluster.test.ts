/**
 * Tests for emergent value clustering. Values must coalesce from similar
 * evidence and stay apart from unrelated evidence, deterministically.
 */

import { describe, expect, it } from "vitest";
import { clusterEvidence } from "../core/soul/cluster.js";
import { HashingEmbedder } from "../core/soul/embedder.js";
import type { Hash } from "../core/soul/types.js";

const embedder = new HashingEmbedder(512);

async function embed(
  texts: string[],
): Promise<{ hash: Hash; vector: number[] }[]> {
  const vectors = await embedder.embed(texts);
  return texts.map((_, i) => ({
    hash: (`sha256:` + String(i).padStart(64, "0")) as Hash,
    vector: vectors[i]!,
  }));
}

describe("clusterEvidence", () => {
  it("merges paraphrases and separates unrelated evidence", async () => {
    const items = await embed([
      "be concise, avoid walls of text",
      "keep it concise, no walls of text please",
      "verify facts before stating them with tools",
    ]);
    const clusters = clusterEvidence(items, 0.5);
    // the two concise paraphrases land together; the verify one stands alone
    expect(clusters.length).toBe(2);
    const sizes = clusters.map((c) => c.members.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it("each cluster names itself with a real member as medoid", async () => {
    const items = await embed(["alpha text one", "alpha text two"]);
    const [cluster] = clusterEvidence(items, 0.6);
    expect(cluster!.members).toContain(cluster!.medoid);
  });

  it("is deterministic regardless of input order", async () => {
    const items = await embed([
      "push back on bad ideas",
      "do not just agree, push back",
      "send a sticker",
    ]);
    const a = clusterEvidence(items, 0.5);
    const b = clusterEvidence([...items].reverse(), 0.5);
    expect(a.map((c) => c.members.sort())).toEqual(
      b.map((c) => c.members.sort()),
    );
  });

  it("a tight threshold produces more, smaller clusters", async () => {
    const items = await embed([
      "concise replies",
      "concise responses",
      "concise messages",
    ]);
    const loose = clusterEvidence(items, 0.9);
    const tight = clusterEvidence(items, 0.05);
    expect(tight.length).toBeGreaterThanOrEqual(loose.length);
  });
});
