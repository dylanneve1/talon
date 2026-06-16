/**
 * Tests for learned valence — meaning discovered from outcomes, not declared.
 */

import { describe, expect, it } from "vitest";
import { ValenceModel } from "../core/soul/valence.js";
import { SoulKernel } from "../core/soul/kernel.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ValenceModel", () => {
  it("returns the prior for an unseen cue", () => {
    const m = new ValenceModel(() => 0.5, 2);
    expect(m.valence("✨")).toBe(0.5);
  });

  it("converges toward the observed mean as evidence accumulates", () => {
    const m = new ValenceModel(() => 0, 2);
    for (let i = 0; i < 50; i++) m.observe("🗿", 1);
    expect(m.valence("🗿")).toBeGreaterThan(0.9);
    expect(m.confidence("🗿")).toBe(50);
  });

  it("can learn a valence that contradicts the prior", () => {
    // prior says +1, but the data says this cue precedes dead conversations
    const m = new ValenceModel(() => 1, 2);
    for (let i = 0; i < 40; i++) m.observe("👍", -1);
    expect(m.valence("👍")).toBeLessThan(0);
  });

  it("snapshots and restores", () => {
    const m = new ValenceModel(() => 0, 2);
    m.observe("🔥", 1);
    const r = ValenceModel.restore(m.snapshot(), () => 0);
    expect(r.valence("🔥")).toBe(m.valence("🔥"));
  });
});

describe("kernel valence integration", () => {
  it("teaches cues from engagement and applies learned valence to reactions", () => {
    const soul = SoulKernel.genesis({ now: 1, seedValues: [{ text: "x" }] });
    // a cue that repeatedly precedes dead conversations earns negative valence
    for (let t = 2; t < 40; t++) {
      soul.ingest({
        kind: "engagement",
        at: t,
        continued: false,
        activeNodes: [],
        cues: ["🤡"],
      });
    }
    expect(soul.valence().valence("🤡")).toBeLessThan(0);
  });

  it("persists the learned valence across save/load", () => {
    const soul = SoulKernel.genesis({ now: 1 });
    for (let t = 2; t < 30; t++) {
      soul.ingest({
        kind: "engagement",
        at: t,
        continued: true,
        activeNodes: [],
        cues: ["💯"],
      });
    }
    const dir = mkdtempSync(join(tmpdir(), "soul-val-"));
    const path = join(dir, "soul.json");
    soul.save(path);
    const loaded = SoulKernel.load(path);
    expect(loaded.valence().valence("💯")).toBeCloseTo(
      soul.valence().valence("💯"),
      10,
    );
  });
});
