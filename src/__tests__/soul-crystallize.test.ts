/**
 * Integration test for kernel.crystallize() — the centerpiece: values that EMERGE
 * from clustered evidence rather than being hand-seeded. End-to-end with the
 * deterministic embedder so no model is involved anywhere.
 */

import { describe, expect, it } from "vitest";
import { SoulKernel } from "../core/soul/kernel.js";
import { HashingEmbedder } from "../core/soul/embedder.js";
import { DEFAULT_SOUL_CONFIG, type ValuePayload } from "../core/soul/types.js";

const embedder = new HashingEmbedder(512);
// The default 0.35 is tuned for a real sentence encoder; the crude hashing
// embedder spaces lexical paraphrases farther apart (~0.5), so loosen for tests.
const config = { ...DEFAULT_SOUL_CONFIG, clusterDistance: 0.6 };

describe("crystallize", () => {
  it("coalesces similar corrections into one emergent value", async () => {
    const soul = SoulKernel.genesis({ now: 1, config });
    // three paraphrased corrections about the same trait + one unrelated
    soul.ingest({
      kind: "correction",
      at: 2,
      text: "stop writing walls of text, be concise",
    });
    soul.ingest({
      kind: "correction",
      at: 3,
      text: "keep replies concise, no walls of text",
    });
    soul.ingest({
      kind: "directive",
      at: 4,
      text: "always verify facts with tools before stating them",
    });

    const created = await soul.crystallize(embedder, 5);
    soul.commit("crystallize", 5);

    // two concise corrections merge → fewer values than raw evidence fragments
    const values = soul.graph().nodesOfKind("value");
    expect(values.length).toBe(2);

    // the merged value carries both concise fragments as members
    const merged = values
      .map((v) => v.payload as ValuePayload)
      .find((v) => v.members.length === 2);
    expect(merged).toBeDefined();
    expect(created.length).toBe(2);
  });

  it("is idempotent — re-crystallizing absorbed evidence creates nothing", async () => {
    const soul = SoulKernel.genesis({ now: 1, config });
    soul.ingest({ kind: "directive", at: 2, text: "be sharp and direct" });
    const first = await soul.crystallize(embedder, 3);
    const second = await soul.crystallize(embedder, 4);
    expect(first.length).toBe(1);
    expect(second.length).toBe(0); // nothing loose remains
  });

  it("emergent values project verbatim and respond to reinforcement", async () => {
    const soul = SoulKernel.genesis({ now: 1, config });
    soul.ingest({
      kind: "directive",
      at: 2,
      text: "push back on bad ideas, do not just agree",
    });
    const [value] = await soul.crystallize(embedder, 3);
    soul.ingest({
      kind: "reaction",
      at: 4,
      emoji: "🔥",
      activeNodes: [value!],
    });
    soul.commit("c", 5);
    const out = soul.project({ now: 5 });
    expect(out.text).toContain("push back on bad ideas");
  });
});
