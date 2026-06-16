/**
 * Tests for the reflex enforcer. These are the guarantees, so they are concrete:
 * the exact fact bags that must and must not fire each canonical reflex.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateReflexes,
  isBlocked,
  seedReflexes,
  type ReflexContext,
} from "../core/soul/reflex.js";

const reflexes = seedReflexes();

function ctx(facts: ReflexContext["facts"]): ReflexContext {
  return { facts };
}

describe("RULE-0-DELIVERY", () => {
  it("fires and blocks when a reply is intended but not delivered", () => {
    const v = evaluateReflexes(
      reflexes,
      ctx({
        "turn.ending": true,
        "turn.replyIntended": true,
        "turn.lastAction": "read_chat_history",
      }),
    );
    expect(v.map((x) => x.name)).toContain("RULE-0-DELIVERY");
    expect(isBlocked(v)).toBe(true);
  });

  it("does not fire when the last action delivered the reply", () => {
    for (const action of ["end_turn", "send", "react"]) {
      const v = evaluateReflexes(
        reflexes,
        ctx({
          "turn.ending": true,
          "turn.replyIntended": true,
          "turn.lastAction": action,
        }),
      );
      expect(v.map((x) => x.name)).not.toContain("RULE-0-DELIVERY");
    }
  });

  it("does not fire when no reply was intended (silent turn)", () => {
    const v = evaluateReflexes(
      reflexes,
      ctx({ "turn.ending": true, "turn.replyIntended": false }),
    );
    expect(v).toHaveLength(0);
  });
});

describe("DEFERRED-TOOL-SEARCH", () => {
  it("blocks claiming a tool is unavailable without searching first", () => {
    const v = evaluateReflexes(
      reflexes,
      ctx({ "claim.toolUnavailable": true, "search.performed": false }),
    );
    expect(v.map((x) => x.name)).toContain("DEFERRED-TOOL-SEARCH");
    expect(isBlocked(v)).toBe(true);
  });

  it("allows the claim once a search has been performed", () => {
    const v = evaluateReflexes(
      reflexes,
      ctx({ "claim.toolUnavailable": true, "search.performed": true }),
    );
    expect(v).toHaveLength(0);
  });
});

describe("PRIVACY-BOUNDARY", () => {
  it("blocks leaking Dylan-private context into a group without his consent", () => {
    const v = evaluateReflexes(
      reflexes,
      ctx({
        surface: "group",
        "disclosure.dylanPrivate": true,
        "consent.dylanRaisedHere": false,
      }),
    );
    expect(v.map((x) => x.name)).toContain("PRIVACY-BOUNDARY");
  });

  it("permits it in a DM surface", () => {
    const v = evaluateReflexes(
      reflexes,
      ctx({ surface: "dm", "disclosure.dylanPrivate": true }),
    );
    expect(v).toHaveLength(0);
  });

  it("permits it in-group when Dylan raised it himself", () => {
    const v = evaluateReflexes(
      reflexes,
      ctx({
        surface: "group",
        "disclosure.dylanPrivate": true,
        "consent.dylanRaisedHere": true,
      }),
    );
    expect(v).toHaveLength(0);
  });
});

describe("ordering + unknown predicates", () => {
  it("returns blocks before softer verdicts", () => {
    const custom = [
      { ...reflexes[0]! },
      {
        kind: "reflex" as const,
        name: "SOFT",
        trigger: "always",
        guard: "always",
        action: "advisory",
        severity: "advise" as const,
      },
    ];
    const v = evaluateReflexes(
      custom,
      ctx({
        "turn.ending": true,
        "turn.replyIntended": true,
        "turn.lastAction": "none",
      }),
    );
    expect(v[0]!.severity).toBe("block");
    expect(v[1]!.severity).toBe("advise");
  });

  it("throws on a reflex naming an unknown predicate", () => {
    expect(() =>
      evaluateReflexes(
        [
          {
            kind: "reflex",
            name: "BAD",
            trigger: "nope",
            guard: "always",
            action: "x",
            severity: "warn",
          },
        ],
        ctx({}),
      ),
    ).toThrow(/unknown predicate/);
  });
});
