/**
 * End-to-end tests for the kernel orchestrator: genesis, the full ingest → commit
 * → project pipeline, persistence round-trip, and the commit chain. This is the
 * integration proof that the model-free loop closes.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoulKernel } from "../core/soul/kernel.js";

describe("genesis", () => {
  it("installs the load-bearing reflexes and an opening commit", () => {
    const soul = SoulKernel.genesis({ now: 1 });
    const out = soul.project({ now: 1 });
    expect(out.text).toContain("RULE-0-DELIVERY");
    expect(soul.history()).toHaveLength(1);
    expect(soul.head()?.summary).toMatch(/^genesis/);
  });

  it("seeds founding values that project verbatim", () => {
    const soul = SoulKernel.genesis({
      now: 1,
      seedValues: [{ text: "sharp, direct, zero corporate polish" }],
    });
    expect(soul.project({ now: 1 }).text).toContain(
      "sharp, direct, zero corporate polish",
    );
  });
});

describe("full pipeline", () => {
  it("learns from signals and reflects it in projection ordering", () => {
    const soul = SoulKernel.genesis({
      now: 1,
      seedValues: [{ text: "be concise" }, { text: "be thorough" }],
    });
    const concise = soul.graph().nodesOfKind("value")[0]!.hash;

    // Reward "concise" repeatedly.
    for (let t = 2; t < 8; t++) {
      soul.ingest({
        kind: "reaction",
        at: t,
        emoji: "🔥",
        activeNodes: [concise],
      });
    }
    soul.commit("learning", 8);

    const out = soul.project({ now: 8 });
    // the rewarded value should now lead the Values section
    const firstValueLine = out.text
      .split("\n")
      .find((l) => l.startsWith("- [conf"));
    expect(firstValueLine).toContain("be concise");
    expect(soul.history()).toHaveLength(2);
  });

  it("a correction adds a spine event visible as continuity", () => {
    const soul = SoulKernel.genesis({ now: 1 });
    soul.ingest({
      kind: "correction",
      at: 2,
      text: "just be grounded and talk naturally",
      actor: "dylan",
    });
    soul.commit("correction", 2);
    expect(soul.project({ now: 2 }).text).toContain(
      "Correction: just be grounded and talk naturally",
    );
  });
});

describe("persistence", () => {
  it("round-trips through disk preserving root, weather, and history", () => {
    const soul = SoulKernel.genesis({
      now: 1,
      seedValues: [{ text: "verify before stating" }],
    });
    const v = soul.graph().nodesOfKind("value")[0]!.hash;
    soul.ingest({ kind: "reaction", at: 2, emoji: "👍", activeNodes: [v] });
    soul.commit("c", 2);

    const dir = mkdtempSync(join(tmpdir(), "soul-"));
    const path = join(dir, "soul.json");
    soul.save(path);
    const loaded = SoulKernel.load(path);

    expect(loaded.graph().root()).toBe(soul.graph().root());
    expect(loaded.graph().stateOf(v).salience).toBe(
      soul.graph().stateOf(v).salience,
    );
    expect(loaded.history()).toHaveLength(soul.history().length);
  });
});

describe("commit chain", () => {
  it("links each commit to its parent root", () => {
    const soul = SoulKernel.genesis({ now: 1 });
    const first = soul.head()!;
    soul.addSeedValue("new trait", 2);
    const second = soul.commit("more", 2);
    expect(second.parent).toBe(first.root);
    expect(second.root).not.toBe(first.root);
  });
});
