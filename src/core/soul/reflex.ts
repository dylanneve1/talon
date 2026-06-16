/**
 * Soul Kernel — the reflex layer. Behavior the kernel *guarantees*, not behavior
 * the prompt merely hopes to elicit.
 *
 * A reflex is pure data in the DAG (`trigger → guard → action`, content-
 * addressed and versioned). The *predicates* it names are tested code in a
 * registry here. That separation is deliberate: the data is portable, hashable,
 * and rolls back with the rest of identity; the logic is unit-tested TypeScript.
 *
 * At a decision point the harness builds a ReflexContext — a flat bag of facts
 * about the current turn — and asks the enforcer which reflexes fire. A fired
 * `block` reflex is an enforceable veto; the model never gets a vote. This is how
 * the recurring RULE 0 delivery failure stops being a recurring failure: it
 * becomes a structural guard, not a note in memory.
 */

import type { ReflexPayload, ReflexSeverity } from "./types.js";

/** Flat, serializable facts about a decision point. */
export interface ReflexContext {
  readonly facts: Readonly<Record<string, boolean | string | number>>;
}

/** A named, pure predicate over the context. */
export type ReflexPredicate = (ctx: ReflexContext) => boolean;

export interface ReflexVerdict {
  readonly name: string;
  readonly severity: ReflexSeverity;
  readonly action: string;
  /** True when both trigger and guard held — i.e. the reflex fired. */
  readonly fired: boolean;
}

const bool = (ctx: ReflexContext, key: string): boolean =>
  ctx.facts[key] === true;

const str = (ctx: ReflexContext, key: string): string => {
  const v = ctx.facts[key];
  return typeof v === "string" ? v : "";
};

/** Actions taken on a turn after a delivery tool — anything else means silence. */
const DELIVERY_ACTIONS = new Set(["end_turn", "send", "react"]);

/**
 * The built-in predicate registry. These names are referenced by reflex data.
 * Keep them small and total; compound conditions get their own named predicate
 * rather than being expressed in the data.
 */
export const BUILTIN_PREDICATES: Readonly<Record<string, ReflexPredicate>> = {
  /** Always-on trigger. */
  always: () => true,

  /** The turn is ending and a user-facing reply was intended. */
  "turn:user-reply-intended": (ctx) =>
    bool(ctx, "turn.ending") && bool(ctx, "turn.replyIntended"),

  /** No delivery tool was the last action — the reply would be lost. */
  "delivery:not-delivered": (ctx) =>
    !DELIVERY_ACTIONS.has(str(ctx, "turn.lastAction")),

  /** About to tell the user a capability/tool is unavailable. */
  "claim:tool-unavailable": (ctx) => bool(ctx, "claim.toolUnavailable"),

  /** A deferred-tool search has not yet been performed this turn. */
  "search:not-performed": (ctx) => !bool(ctx, "search.performed"),

  /** In a group surface AND about to disclose Dylan-private information. */
  "context:group-private-disclosure": (ctx) =>
    str(ctx, "surface") === "group" && bool(ctx, "disclosure.dylanPrivate"),

  /** Dylan did not himself raise this fact in this thread. */
  "consent:absent": (ctx) => !bool(ctx, "consent.dylanRaisedHere"),
};

/** Resolve a predicate name, falling back to a registry override map. */
function resolve(
  name: string,
  overrides?: Readonly<Record<string, ReflexPredicate>>,
): ReflexPredicate {
  const p = overrides?.[name] ?? BUILTIN_PREDICATES[name];
  if (!p) throw new Error(`reflex: unknown predicate "${name}"`);
  return p;
}

/** Evaluate one reflex against a context. */
export function evaluateReflex(
  reflex: ReflexPayload,
  ctx: ReflexContext,
  overrides?: Readonly<Record<string, ReflexPredicate>>,
): ReflexVerdict {
  const armed = resolve(reflex.trigger, overrides)(ctx);
  const tripped = armed && resolve(reflex.guard, overrides)(ctx);
  return {
    name: reflex.name,
    severity: reflex.severity,
    action: reflex.action,
    fired: tripped,
  };
}

/**
 * Evaluate every reflex, returning only those that fired, hardest first. The
 * harness blocks the turn if any `block` verdict is present.
 */
export function evaluateReflexes(
  reflexes: readonly ReflexPayload[],
  ctx: ReflexContext,
  overrides?: Readonly<Record<string, ReflexPredicate>>,
): ReflexVerdict[] {
  const order: Record<ReflexSeverity, number> = {
    block: 0,
    warn: 1,
    advise: 2,
  };
  return reflexes
    .map((r) => evaluateReflex(r, ctx, overrides))
    .filter((v) => v.fired)
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

/** True if any fired verdict is an enforceable block. */
export function isBlocked(verdicts: readonly ReflexVerdict[]): boolean {
  return verdicts.some((v) => v.severity === "block");
}

/**
 * The canonical load-bearing reflexes, installed at kernel genesis. These encode
 * the three operating scars that recur in Talon's memory: lost replies, claiming
 * a deferred tool is unavailable without searching, and leaking Dylan-private
 * context into a group.
 */
export function seedReflexes(): ReflexPayload[] {
  return [
    {
      kind: "reflex",
      name: "RULE-0-DELIVERY",
      trigger: "turn:user-reply-intended",
      guard: "delivery:not-delivered",
      action:
        "BLOCK: the reply is private scratchpad until delivered — call end_turn/send/react before ending the turn.",
      severity: "block",
    },
    {
      kind: "reflex",
      name: "DEFERRED-TOOL-SEARCH",
      trigger: "claim:tool-unavailable",
      guard: "search:not-performed",
      action:
        "BLOCK: run tool_search for the capability before telling the user it is unavailable.",
      severity: "block",
    },
    {
      kind: "reflex",
      name: "PRIVACY-BOUNDARY",
      trigger: "context:group-private-disclosure",
      guard: "consent:absent",
      action:
        "BLOCK: do not disclose Dylan-private context in a group unless he raised it here himself.",
      severity: "block",
    },
  ];
}
