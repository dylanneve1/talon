/**
 * Soul Kernel — the projector. Compiles the DAG to the runtime surface that is
 * injected into the system prompt.
 *
 * The defining constraint: the projector **selects**, it never **writes**. Every
 * substantive line is a verbatim evidence fragment already in the DAG (the
 * medoid of a value, a spine event, a lens-scoped quote). The only generated
 * text is fixed structural scaffolding — section headers and the action strings
 * of reflexes, which are themselves authored data, not claims about Talon. The
 * soul therefore cannot hallucinate itself: it can only ever quote ground truth.
 *
 * Selection is salience-ordered under a token budget, so the surface carries what
 * is *currently alive*, not everything ever true. Reflexes are exempt from the
 * budget — guarantees are never dropped.
 */

import { SoulDag } from "./dag.js";
import { isSuperseded } from "./consolidate.js";
import { tensionPairs } from "./lattice.js";
import { confidence, effectiveSalience } from "./salience.js";
import type { Hash, LensPayload, SoulConfig, ValuePayload } from "./types.js";

export interface ProjectionOptions {
  readonly now: number;
  readonly config: SoulConfig;
  /** If set, refract the projection through this subject's lens, when present. */
  readonly lens?: string;
  /**
   * Optional precomputed value ordering (e.g. from context-conditioned
   * retrieval). When present it overrides salience ranking, letting the soul
   * surface what is relevant to the current moment. Hashes not listed are
   * dropped from the value section.
   */
  readonly order?: readonly Hash[];
}

export interface Projection {
  readonly text: string;
  readonly tokens: number;
  readonly includedValues: readonly Hash[];
  readonly droppedValues: number;
}

/** Cheap, tokenizer-free token estimate (~4 chars/token). Deterministic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function evidenceText(
  dag: SoulDag,
  hash: Hash | undefined,
): string | undefined {
  if (!hash) return undefined;
  const node = dag.getNode(hash);
  return node?.payload.kind === "evidence" ? node.payload.text : undefined;
}

/** The medoid evidence hash of a value node, if it is one. */
function valueMedoid(dag: SoulDag, hash: Hash): Hash | undefined {
  const node = dag.getNode(hash);
  return node?.payload.kind === "value"
    ? (node.payload as ValuePayload).medoid
    : undefined;
}

/** Map of value-hash → amplification factor for a subject's lens. */
function lensFactors(dag: SoulDag, subject?: string): Map<Hash, number> {
  const factors = new Map<Hash, number>();
  if (!subject) return factors;
  for (const node of dag.nodesOfKind("lens")) {
    if (isSuperseded(dag, node.hash)) continue;
    const lens = node.payload as LensPayload;
    if (lens.subject !== subject) continue;
    for (const a of lens.amplify) factors.set(a.node, a.factor);
  }
  return factors;
}

interface RankedValue {
  readonly hash: Hash;
  readonly medoidText: string;
  readonly conf: number;
  readonly weighted: number;
}

function rankValues(dag: SoulDag, opts: ProjectionOptions): RankedValue[] {
  const factors = lensFactors(dag, opts.lens);
  const ranked: RankedValue[] = [];
  for (const node of dag.nodesOfKind("value")) {
    if (isSuperseded(dag, node.hash)) continue; // merged-away values are dead
    const value = node.payload as ValuePayload;
    const text = evidenceText(dag, value.medoid);
    if (!text) continue; // a value with no resolvable medoid is not projectable
    const state = dag.stateOf(node.hash);
    const base = effectiveSalience(
      state,
      opts.now,
      opts.config.decayHalfLifeMs,
    );
    const factor = factors.get(node.hash) ?? 1;
    ranked.push({
      hash: node.hash,
      medoidText: text,
      conf: confidence(state),
      weighted: base * factor,
    });
  }
  // Highest weighted salience first; hash tiebreak keeps output deterministic.
  ranked.sort(
    (a, b) => b.weighted - a.weighted || a.hash.localeCompare(b.hash),
  );

  // An explicit retrieval order (context-conditioned) overrides salience rank.
  if (opts.order) {
    const rank = new Map(opts.order.map((h, i) => [h, i]));
    return ranked
      .filter((r) => rank.has(r.hash))
      .sort((a, b) => rank.get(a.hash)! - rank.get(b.hash)!);
  }
  return ranked;
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;
}

/**
 * Project the kernel to its runtime markdown surface. Reflexes are always
 * included; values fill the remaining token budget by weighted salience; recent
 * spine events provide continuity with whatever budget is left.
 */
export function projectRuntime(
  dag: SoulDag,
  opts: ProjectionOptions,
): Projection {
  const lines: string[] = [];
  lines.push("# Talon — compiled identity (soul)");
  lines.push(
    `<!-- selected from ${dag.size} nodes; root ${dag.root()}; generated, do not edit -->`,
  );

  // Reflexes — enforced guarantees, never budgeted away.
  const reflexes = dag.nodesOfKind("reflex");
  if (reflexes.length) {
    lines.push("", "## Reflexes (enforced)");
    for (const r of reflexes) {
      if (r.payload.kind !== "reflex") continue;
      lines.push(`- **${r.payload.name}** — ${r.payload.action}`);
    }
  }

  let budget = opts.config.runtimeBudgetTokens;
  const spend = (s: string): boolean => {
    const cost = estimateTokens(s);
    if (cost > budget) return false;
    budget -= cost;
    return true;
  };
  // Reflexes already spent conceptually fixed cost; charge the header block.
  budget -= estimateTokens(lines.join("\n"));

  // Values — salience-ordered, verbatim medoids, until the budget is spent.
  const ranked = rankValues(dag, opts);
  const included: Hash[] = [];
  let dropped = 0;
  const valueLines: string[] = [];
  for (const v of ranked) {
    const line = `- [conf ${signed(v.conf)}] "${v.medoidText}"`;
    if (spend(line)) {
      valueLines.push(line);
      included.push(v.hash);
    } else {
      dropped++;
    }
  }
  if (valueLines.length) {
    const header = opts.lens ? `## Values (with ${opts.lens})` : "## Values";
    lines.push("", header, ...valueLines);
  }

  // Themes — higher-order reflections over the values.
  const themeNodes = dag
    .nodesOfKind("theme")
    .map((n) => n.payload)
    .filter(
      (p): p is Extract<typeof p, { kind: "theme" }> => p.kind === "theme",
    )
    .map((p) => ({
      label: p.insight ?? evidenceText(dag, p.medoid) ?? "",
      salience: 0,
      medoid: p.medoid,
    }))
    .filter((t) => t.label.length > 0);
  const themeLines: string[] = [];
  for (const t of themeNodes) {
    const line = `- ${t.label}`;
    if (spend(line)) themeLines.push(line);
  }
  if (themeLines.length)
    lines.push("", "## Themes (reflections)", ...themeLines);

  // Tensions — opposed values held together, navigated not resolved.
  const includedSet = new Set(included);
  const tensionLines: string[] = [];
  for (const pair of tensionPairs(dag)) {
    if (!includedSet.has(pair.a) || !includedSet.has(pair.b)) continue;
    const ta = evidenceText(dag, valueMedoid(dag, pair.a));
    const tb = evidenceText(dag, valueMedoid(dag, pair.b));
    if (!ta || !tb) continue;
    const line = `- "${ta}"  ⟷  "${tb}"`;
    if (spend(line)) tensionLines.push(line);
  }
  if (tensionLines.length) {
    lines.push("", "## Tensions (navigated, not resolved)", ...tensionLines);
  }

  // Continuity — most recent spine events first, with remaining budget.
  const spine = dag
    .nodesOfKind("spine")
    .map((n) => n.payload)
    .filter(
      (p): p is Extract<typeof p, { kind: "spine" }> => p.kind === "spine",
    )
    .sort((a, b) => b.at - a.at);
  const spineLines: string[] = [];
  for (const s of spine) {
    const line = `- ${s.event}`;
    if (spend(line)) spineLines.push(line);
  }
  if (spineLines.length) lines.push("", "## Continuity (spine)", ...spineLines);

  const text = lines.join("\n");
  return {
    text,
    tokens: estimateTokens(text),
    includedValues: included,
    droppedValues: dropped,
  };
}
