/**
 * Tests for reflection — higher-order themes forming over coherent, co-active
 * values, model-free, with an optional label-only synthesize hook.
 */

import { describe, expect, it } from "vitest";
import { SoulKernel } from "../core/soul/kernel.js";
import { reflect } from "../core/soul/reflect.js";
import { TalonEmbedder } from "../core/soul/talon-embedder.js";
import type { ThemePayload } from "../core/soul/types.js";

const embedder = new TalonEmbedder();

function soulWith(seed: string[]): SoulKernel {
  return SoulKernel.genesis({
    now: 1,
    seedValues: seed.map((text) => ({ text })),
  });
}

describe("reflect", () => {
  it("forms a theme over semantically coherent values", async () => {
    const soul = soulWith([
      "keep replies concise and short",
      "keep responses concise and brief",
      "book a flight to nice in june",
    ]);
    const res = await reflect(soul.graph(), embedder, soul.config, {
      now: 2,
      affinity: 0.45,
      embeddingWeight: 1, // semantic-only for a deterministic lexical test
    });
    expect(res.created.length).toBe(1);
    const theme = soul.graph().getNode(res.created[0]!)!
      .payload as ThemePayload;
    expect(theme.values.length).toBe(2); // the two concise values, not the flight
  });

  it("labels a theme with its medoid by default, and projects it", async () => {
    const soul = soulWith([
      "be sharp and direct",
      "stay sharp, be direct and blunt",
    ]);
    await reflect(soul.graph(), embedder, soul.config, {
      now: 2,
      affinity: 0.4,
      embeddingWeight: 1,
    });
    soul.commit("reflect", 2);
    expect(soul.project({ now: 2 }).text).toContain("## Themes (reflections)");
  });

  it("uses the optional synthesize hook for a label but not for grouping", async () => {
    const soul = soulWith([
      "verify facts before stating",
      "always verify facts with tools first",
    ]);
    let sawMembers = 0;
    const res = await reflect(soul.graph(), embedder, soul.config, {
      now: 2,
      affinity: 0.4,
      embeddingWeight: 1,
      synthesize: (members) => {
        sawMembers = members.length;
        return "I value epistemic care";
      },
    });
    const theme = soul.graph().getNode(res.created[0]!)!
      .payload as ThemePayload;
    expect(theme.insight).toBe("I value epistemic care");
    expect(sawMembers).toBeGreaterThan(0);
    soul.commit("r", 2);
    expect(soul.project({ now: 2 }).text).toContain("I value epistemic care");
  });

  it("does nothing with fewer than two values", async () => {
    const soul = soulWith(["only one value"]);
    const res = await reflect(soul.graph(), embedder, soul.config, { now: 2 });
    expect(res.created).toHaveLength(0);
  });
});
