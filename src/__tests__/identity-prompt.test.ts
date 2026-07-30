/**
 * Tests for the identity prompt — Talon's authored voice.
 *
 * The file used to open with six adjectives ("Sharp, witty, and warm"), which
 * describe ten thousand assistants and constrain nothing. It now specifies
 * behaviour instead: concrete stances on concrete situations, plus explicit
 * anti-examples, which constrain far harder than any adjective.
 *
 * These tests guard the two properties that are easy to lose by accident:
 * the stances staying present, and the voice norms not drifting back into
 * per-frontend copies.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../prompts",
);

const read = (rel: string): string =>
  readFileSync(resolve(PROMPTS, rel), "utf-8");

describe("identity.md", () => {
  const identity = read("identity.md");

  it("specifies stances rather than adjectives", () => {
    expect(identity).toContain("## Stances");
    // The situations that actually define a voice.
    expect(identity).toMatch(/Their plan is bad/);
    expect(identity).toMatch(/You don't know/);
    expect(identity).toMatch(/You were wrong/);
    expect(identity).toMatch(/They're annoyed/);
    expect(identity).toMatch(/already answered/);
    expect(identity).toMatch(/request is ambiguous/);
    expect(identity).toMatch(/nothing to add/);
  });

  it("no longer opens with an adjective list", () => {
    expect(identity).not.toContain("Sharp, witty, and warm");
    expect(identity).not.toContain("## Personality");
  });

  it("carries anti-examples, not just positive guidance", () => {
    expect(identity).toContain("## Never");
    expect(identity).toMatch(/as I mentioned/);
    expect(identity).toMatch(/Stacked hedges/);
  });

  it("keeps the functional sections the runtime depends on", () => {
    // Identity bootstrap drives first-run setup; Memory names the file the
    // agent writes. Losing either breaks behaviour, not just tone.
    expect(identity).toContain("## Identity Bootstrap");
    expect(identity).toContain("~/.talon/workspace/identity.md");
  });

  it("delegates memory mechanics rather than restating them", () => {
    // `prompts/system/memory-recall.md` owns the save/recall policy. identity.md
    // is the voice spec and must not grow a second copy of that policy.
    expect(identity).toMatch(/Memory and Recall policy/);
    expect(identity).not.toMatch(/memory\/daily/);
    expect(identity).not.toMatch(/state\.md/);
  });

  it("stays lean enough for a per-session static prompt", () => {
    // This ships in staticText on every session. The Agent SDK exposes no
    // cache-TTL control, so prompt size is the only cache lever we have —
    // a voice spec that doubles in length is a real cost.
    expect(identity.length).toBeLessThan(6_000);
  });
});

describe("voice lives in one place", () => {
  const FRONTENDS = [
    "telegram.md",
    "discord.md",
    "teams.md",
    "native.md",
    "terminal.md",
  ];

  it("does not repeat the reply-optional norm per frontend", () => {
    // Four frontends each carried their own copy, and they had already
    // drifted ("You don't HAVE to" vs "You don't have to"). The norm belongs
    // to identity.md; the frontends keep only their platform mechanics.
    for (const file of FRONTENDS) {
      expect(read(file)).not.toMatch(/don't (HAVE|have) to respond/i);
    }
  });

  it("keeps each frontend's platform-specific mechanics", () => {
    // De-duplication must not have taken the capability docs with it.
    expect(read("telegram.md")).toMatch(/limited reaction set/);
    expect(read("discord.md")).toMatch(/unicode emoji only/i);
    expect(read("teams.md")).toMatch(/no reaction surface/);
    expect(read("native.md")).toMatch(/reaction can stand in/);
  });
});

describe("prompt norms match mechanical enforcement", () => {
  /**
   * The phrases `soul/critic.ts` scores as sycophancy. Duplicated here as a
   * literal rather than imported: that module is scheduled for teardown (its
   * classifier moves to `core/persona/` when it is actually wired), and
   * adding an export to it now would leave an import for the teardown PR to
   * clean up. The real cross-check belongs with the PR that wires the critic
   * as an output guard — this asserts the prompt side only.
   */
  const CRITIC_SYCOPHANCY = [
    "great question",
    "excellent question",
    "you're absolutely right",
    "i'd be happy to",
    "absolutely!",
    "certainly!",
    "of course!",
    "happy to help",
    "great point",
  ];

  it("warns against every phrase the critic classifier scores", () => {
    // If the prompt does not name a phrase the classifier penalises, the
    // model is graded on a rule it was never told. Checking this caught four
    // uncovered phrases when the Never list was first written.
    const never = read("identity.md")
      .split("## Never")[1]
      ?.split("\n## ")[0]
      ?.toLowerCase();
    expect(never).toBeTruthy();
    const uncovered = CRITIC_SYCOPHANCY.filter((p) => !never!.includes(p));
    expect(uncovered).toEqual([]);
  });
});
