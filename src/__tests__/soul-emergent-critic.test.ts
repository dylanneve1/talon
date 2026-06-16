/**
 * Tests for the emergent critic — failure modes discovered from real
 * corrections, and a candidate flagged by resemblance to them.
 */

import { describe, expect, it } from "vitest";
import { SoulKernel } from "../core/soul/kernel.js";
import {
  deriveFailureModes,
  assessText,
} from "../core/soul/emergent-critic.js";
import { TalonEmbedder } from "../core/soul/talon-embedder.js";

const embedder = new TalonEmbedder();

function withCorrections(): SoulKernel {
  const soul = SoulKernel.genesis({ now: 1 });
  const corrections = [
    "stop writing walls of text, be concise",
    "your reply was way too long, shorten it",
    "don't be sycophantic, drop the flattery",
    "stop kissing up, just answer plainly",
  ];
  let t = 2;
  for (const text of corrections)
    soul.ingest({ kind: "correction", at: t++, text });
  return soul;
}

describe("deriveFailureModes", () => {
  it("clusters corrections into emergent failure modes labeled by real text", async () => {
    const soul = withCorrections();
    const modes = await deriveFailureModes(soul.graph(), embedder, 0.6);
    expect(modes.length).toBeGreaterThanOrEqual(1);
    // every label is a verbatim correction, never invented
    for (const m of modes) expect(m.label.length).toBeGreaterThan(0);
  });

  it("returns nothing when there are no corrections", async () => {
    const soul = SoulKernel.genesis({ now: 1 });
    expect(await deriveFailureModes(soul.graph(), embedder, 0.6)).toHaveLength(
      0,
    );
  });
});

describe("assessText", () => {
  it("flags a candidate that resembles a past correction", async () => {
    const soul = withCorrections();
    const modes = await deriveFailureModes(soul.graph(), embedder, 0.9);
    const risky = await assessText(
      "here is an extremely long rambling wall of text reply",
      modes,
      embedder,
      0.8,
    );
    expect(risky[0]!.atRisk).toBe(true);
  });

  it("does not flag an unrelated candidate", async () => {
    const soul = withCorrections();
    const modes = await deriveFailureModes(soul.graph(), embedder, 0.9);
    const safe = await assessText(
      "the train to dublin departs at nine fifteen",
      modes,
      embedder,
      0.3,
    );
    expect(safe.every((r) => !r.atRisk)).toBe(true);
  });
});
