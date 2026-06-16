/**
 * Tests for ADWIN concept-drift detection and its Spine-epoch integration.
 */

import { describe, expect, it } from "vitest";
import { Adwin } from "../core/soul/drift.js";
import { SoulKernel } from "../core/soul/kernel.js";

describe("Adwin", () => {
  it("stays quiet on a stationary stream", () => {
    const a = new Adwin();
    let changes = 0;
    for (let i = 0; i < 200; i++) if (a.add(1).changed) changes++;
    expect(changes).toBe(0);
  });

  it("detects an abrupt mean shift", () => {
    const a = new Adwin();
    for (let i = 0; i < 100; i++) a.add(0);
    let detected = false;
    for (let i = 0; i < 100 && !detected; i++) detected = a.add(1).changed;
    expect(detected).toBe(true);
  });

  it("forgets the stale era after a change (window shrinks)", () => {
    const a = new Adwin();
    for (let i = 0; i < 100; i++) a.add(0);
    const before = a.width;
    for (let i = 0; i < 100; i++) a.add(1);
    expect(a.width).toBeLessThan(before + 100);
    expect(a.mean).toBeGreaterThan(0.5);
  });

  it("snapshots and restores", () => {
    const a = new Adwin();
    for (let i = 0; i < 10; i++) a.add(0.5);
    const r = Adwin.restore(a.snapshot());
    expect(r.width).toBe(a.width);
    expect(r.mean).toBeCloseTo(a.mean, 10);
  });
});

describe("kernel drift → spine epoch", () => {
  it("writes an epoch event when reception flips", () => {
    const soul = SoulKernel.genesis({ now: 1, seedValues: [{ text: "x" }] });
    const v = soul.graph().nodesOfKind("value")[0]!.hash;
    let t = 2;
    // a long run of positive reception, then a sustained flip to negative
    for (let i = 0; i < 60; i++) {
      soul.ingest({ kind: "reaction", at: t++, emoji: "🔥", activeNodes: [v] });
    }
    for (let i = 0; i < 60; i++) {
      soul.ingest({ kind: "reaction", at: t++, emoji: "👎", activeNodes: [v] });
    }
    const epoch = soul
      .graph()
      .nodesOfKind("spine")
      .some(
        (n) =>
          n.payload.kind === "spine" && n.payload.event.startsWith("Epoch:"),
      );
    expect(epoch).toBe(true);
  });
});
