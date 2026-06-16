/**
 * Tests for context-conditioned retrieval (Generative Agents). The same soul
 * surfaces different values depending on the current moment.
 */

import { describe, expect, it } from "vitest";
import { SoulKernel } from "../core/soul/kernel.js";
import { retrieveValues } from "../core/soul/retrieve.js";
import { TalonEmbedder } from "../core/soul/talon-embedder.js";

const embedder = new TalonEmbedder();

function soulWith(): SoulKernel {
  return SoulKernel.genesis({
    now: 1,
    seedValues: [
      { text: "keep replies concise and short" },
      { text: "verify facts with tools before stating" },
      { text: "push back on bad ideas instead of agreeing" },
    ],
  });
}

describe("retrieveValues", () => {
  it("relevance reorders toward the current context", async () => {
    const soul = soulWith();
    const ranked = await retrieveValues(soul.graph(), embedder, {
      now: 1,
      config: soul.config,
      context: "should I just agree with this bad idea or argue?",
      weights: { recency: 0, importance: 0, relevance: 1 },
    });
    expect(ranked[0]!.relevance).toBeGreaterThanOrEqual(ranked[1]!.relevance);
    expect(soul.graph().getNode(ranked[0]!.hash)?.payload.kind).toBe("value");
    // the "push back" value should be the most relevant to an argue/agree prompt
    const top = soul.graph().getNode(ranked[0]!.hash);
    if (top?.payload.kind === "value") {
      const medoid = soul.graph().getNode(top.payload.medoid);
      if (medoid?.payload.kind === "evidence") {
        expect(medoid.payload.text).toContain("push back");
      }
    }
  });

  it("falls back to recency+importance with no context", async () => {
    const soul = soulWith();
    const ranked = await retrieveValues(soul.graph(), embedder, {
      now: 1,
      config: soul.config,
    });
    expect(ranked).toHaveLength(3);
    expect(ranked.every((r) => r.relevance === 0)).toBe(true);
  });

  it("projectFor surfaces the relevant value first", async () => {
    const soul = soulWith();
    const out = await soul.projectFor(embedder, {
      now: 1,
      context: "keep it short and concise, quick question",
      weights: { recency: 0, importance: 0, relevance: 1 },
    });
    const firstValue = out.text
      .split("\n")
      .find((l) => l.startsWith("- [conf"));
    expect(firstValue).toContain("concise");
  });
});
