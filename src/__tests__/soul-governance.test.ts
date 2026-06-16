/**
 * Tests for the protected-node approval queue: proposals do not take effect
 * until approved, rejection drops them, and the queue persists.
 */

import { describe, expect, it } from "vitest";
import { ApprovalQueue } from "../core/soul/governance.js";
import { SoulKernel } from "../core/soul/kernel.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReflexPayload } from "../core/soul/types.js";

const newReflex: ReflexPayload = {
  kind: "reflex",
  name: "NO-LATE-NIGHT-DOOMPOST",
  trigger: "always",
  guard: "always",
  action: "advise: sleep on it",
  severity: "advise",
};

describe("ApprovalQueue", () => {
  it("dedupes a pending proposal for the same payload", () => {
    const q = new ApprovalQueue();
    const a = q.propose(newReflex, "r1", 1);
    const b = q.propose(newReflex, "r2", 2);
    expect(a.id).toBe(b.id);
    expect(q.pending()).toHaveLength(1);
  });

  it("returns the payload only on approval", () => {
    const q = new ApprovalQueue();
    const p = q.propose(newReflex, "r", 1);
    expect(q.resolve(p.id, false, 2)).toBeUndefined();
    expect(q.pending()).toHaveLength(0);
  });
});

describe("kernel governance", () => {
  it("a proposed reflex does not take effect until approved", () => {
    const soul = SoulKernel.genesis({ now: 1 });
    const before = soul.graph().nodesOfKind("reflex").length;
    const p = soul.propose(newReflex, "compiler noticed a pattern", 2);
    // not applied yet
    expect(soul.graph().nodesOfKind("reflex").length).toBe(before);
    expect(soul.pendingApprovals()).toHaveLength(1);

    const hash = soul.approve(p.id, 3);
    expect(hash).toBeDefined();
    expect(soul.graph().nodesOfKind("reflex").length).toBe(before + 1);
    expect(soul.pendingApprovals()).toHaveLength(0);
  });

  it("a rejected proposal is never applied", () => {
    const soul = SoulKernel.genesis({ now: 1 });
    const before = soul.graph().nodesOfKind("reflex").length;
    const p = soul.propose(newReflex, "r", 2);
    expect(soul.reject(p.id, 3)).toBe(true);
    expect(soul.approve(p.id, 4)).toBeUndefined();
    expect(soul.graph().nodesOfKind("reflex").length).toBe(before);
  });

  it("pending approvals persist across save/load", () => {
    const soul = SoulKernel.genesis({ now: 1 });
    soul.propose(newReflex, "r", 2);
    const dir = mkdtempSync(join(tmpdir(), "soul-gov-"));
    const path = join(dir, "soul.json");
    soul.save(path);
    const loaded = SoulKernel.load(path);
    expect(loaded.pendingApprovals()).toHaveLength(1);
  });
});
