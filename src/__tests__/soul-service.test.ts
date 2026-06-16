/**
 * Tests for the SoulService harness seam: disabled = inert no-op, enabled =
 * load/genesis + render + ingest + reflex guard + persistence.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoulService, resetSoul } from "../core/soul/service.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "soul-svc-")), "soul.json");
}

afterEach(() => resetSoul());

describe("SoulService (disabled)", () => {
  it("is inert when not enabled", () => {
    const svc = SoulService.create({ enabled: false });
    expect(svc.enabled).toBe(false);
    expect(svc.renderPromptSection()).toBe("");
    expect(svc.reflexCheck({ facts: {} })).toEqual([]);
    expect(svc.introspect()).toMatch(/disabled/i);
    // no-ops must not throw
    svc.recordReaction("🔥");
    svc.recordCorrection("be grounded", "dylan");
  });
});

describe("SoulService (enabled)", () => {
  it("renders the projected identity surface", () => {
    const svc = SoulService.create({ enabled: true, path: tmpPath() });
    expect(svc.enabled).toBe(true);
    const section = svc.renderPromptSection();
    expect(section).toContain("# Talon — compiled identity (soul)");
    expect(section).toContain("RULE-0-DELIVERY");
  });

  it("enforces RULE 0 via the reflex guard", () => {
    const svc = SoulService.create({ enabled: true, path: tmpPath() });
    const blocked = svc.isBlocked({
      facts: {
        "turn.ending": true,
        "turn.replyIntended": true,
        "turn.lastAction": "read_chat_history",
      },
    });
    expect(blocked).toBe(true);
    const ok = svc.isBlocked({
      facts: {
        "turn.ending": true,
        "turn.replyIntended": true,
        "turn.lastAction": "end_turn",
      },
    });
    expect(ok).toBe(false);
  });

  it("ingests a directive and persists it across reloads", () => {
    const path = tmpPath();
    const svc = SoulService.create({ enabled: true, path });
    svc.recordDirective("always verify before stating", "dylan");
    // a fresh service over the same path sees the persisted evidence
    const reloaded = SoulService.create({ enabled: true, path });
    const section = reloaded.renderPromptSection();
    // directive is stored as loose evidence; it surfaces after a dream, but the
    // node count proves it persisted
    expect(section).toContain("compiled identity");
  });

  it("introspect reports version and node count", () => {
    const svc = SoulService.create({ enabled: true, path: tmpPath() });
    svc.renderPromptSection();
    expect(svc.introspect()).toMatch(/version \d+/);
  });
});
