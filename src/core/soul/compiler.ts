/**
 * Soul Kernel — the compiler. Maps structured signals to arithmetic updates.
 *
 * This is the "writing the self" process, and it contains no model call. Each
 * signal routes to the pure update rules in salience.ts:
 *
 *   reaction / engagement → reinforce or penalize the active values + Hebbian
 *                           co-activation of the set that fired together.
 *   correction            → store the verbatim text as evidence, append a Spine
 *                           event (corrections are formative), penalize whatever
 *                           values were live when it landed.
 *   directive             → store the verbatim instruction as evidence for later
 *                           clustering into a value (embedder phase).
 *   reflex-fire (block)   → record the near-miss in the Spine.
 *   activation            → co-activate the live set; a faint reinforcement.
 *
 * Evidence is always verbatim ground truth; the compiler never paraphrases.
 */

import { SoulDag } from "./dag.js";
import { coactivate, reinforce } from "./salience.js";
import { reinforceFsrs } from "./forgetting.js";
import { emojiValence } from "./signals.js";
import type { CorrectionSignal, DirectiveSignal, Signal } from "./signals.js";
import type { EvidencePayload, Hash, SoulConfig } from "./types.js";
import { halfLifeForKind } from "./types.js";

export interface IngestResult {
  /** Evidence node created from a correction/directive, if any. */
  readonly evidenceAdded?: Hash;
  /** Spine event appended, if any. */
  readonly spineAdded?: Hash;
  /** Nodes whose state was touched. */
  readonly touched: readonly Hash[];
}

/** Find the most recent spine node to chain a new event onto. */
function latestSpine(dag: SoulDag): Hash | undefined {
  let best: Hash | undefined;
  let bestAt = -Infinity;
  for (const node of dag.nodesOfKind("spine")) {
    if (node.payload.kind === "spine" && node.payload.at > bestAt) {
      bestAt = node.payload.at;
      best = node.hash;
    }
  }
  return best;
}

/** Append a developmental-narrative event, chained to the prior spine node. */
export function appendSpine(
  dag: SoulDag,
  event: string,
  at: number,
  affects: readonly Hash[] = [],
): Hash {
  return dag.addNode({
    kind: "spine",
    event,
    at,
    affects: [...affects],
    prev: latestSpine(dag),
  });
}

function addEvidence(
  dag: SoulDag,
  text: string,
  at: number,
  origin: EvidencePayload["source"]["origin"],
  actor?: string,
  ref?: string,
): Hash {
  return dag.addNode({
    kind: "evidence",
    text,
    observedAt: at,
    source: { origin, ...(actor ? { actor } : {}), ...(ref ? { ref } : {}) },
  });
}

function reinforceNode(
  dag: SoulDag,
  hash: Hash,
  cfg: SoulConfig,
  amount: number,
  valence: number,
  at: number,
): void {
  const kind = dag.getNode(hash)?.payload.kind;
  if (cfg.adaptiveForgetting) {
    reinforceFsrs(dag.stateOf(hash), {
      now: at,
      cfg,
      amount,
      valence,
      ...(kind !== undefined ? { kind } : {}),
    });
    dag.touch(hash);
    return;
  }
  reinforce(dag, hash, {
    now: at,
    halfLifeMs: halfLifeForKind(cfg, kind),
    amount,
    valence,
  });
}

function ingestOutcome(
  dag: SoulDag,
  nodes: readonly Hash[],
  valence: number,
  cfg: SoulConfig,
  at: number,
): Hash[] {
  const present = nodes.filter((h) => dag.hasNode(h));
  for (const h of present) {
    reinforceNode(dag, h, cfg, cfg.reinforce, valence, at);
  }
  if (present.length > 1) {
    coactivate(dag, present, { now: at, increment: cfg.hebbIncrement });
  }
  return present;
}

function ingestCorrection(
  dag: SoulDag,
  sig: CorrectionSignal,
  cfg: SoulConfig,
): IngestResult {
  const evidence = addEvidence(
    dag,
    sig.text,
    sig.at,
    "correction",
    sig.actor,
    sig.ref,
  );
  const spine = appendSpine(dag, `Correction: ${sig.text}`, sig.at, [evidence]);
  // Penalize values that were live when the correction landed.
  const penalized = ingestOutcome(dag, sig.activeNodes ?? [], -2, cfg, sig.at);
  return { evidenceAdded: evidence, spineAdded: spine, touched: penalized };
}

function ingestDirective(dag: SoulDag, sig: DirectiveSignal): IngestResult {
  const evidence = addEvidence(
    dag,
    sig.text,
    sig.at,
    "directive",
    sig.actor,
    sig.ref,
  );
  return { evidenceAdded: evidence, touched: [] };
}

/** Apply one signal to the kernel. Pure arithmetic + verbatim evidence.
 *
 * `valenceOf` resolves a cue's valence; pass a learned ValenceModel.valence to
 * let meaning come from data, or omit to use the static emoji prior. */
export function ingest(
  dag: SoulDag,
  signal: Signal,
  cfg: SoulConfig,
  valenceOf: (cue: string) => number = emojiValence,
): IngestResult {
  switch (signal.kind) {
    case "reaction": {
      const v = valenceOf(signal.emoji);
      const touched = ingestOutcome(dag, signal.activeNodes, v, cfg, signal.at);
      return { touched };
    }
    case "engagement": {
      const v = signal.continued ? 1 : -1;
      const touched = ingestOutcome(dag, signal.activeNodes, v, cfg, signal.at);
      return { touched };
    }
    case "correction":
      return ingestCorrection(dag, signal, cfg);
    case "directive":
      return ingestDirective(dag, signal);
    case "reflex-fire": {
      if (signal.severity !== "block") return { touched: [] };
      const spine = appendSpine(
        dag,
        `Reflex blocked a misstep: ${signal.name}`,
        signal.at,
      );
      return { spineAdded: spine, touched: [] };
    }
    case "activation": {
      const touched = ingestOutcome(dag, signal.activeNodes, 0, cfg, signal.at);
      return { touched };
    }
  }
}

/** Apply a batch of signals in order. */
export function ingestAll(
  dag: SoulDag,
  signals: readonly Signal[],
  cfg: SoulConfig,
  valenceOf: (cue: string) => number = emojiValence,
): IngestResult[] {
  return signals.map((s) => ingest(dag, s, cfg, valenceOf));
}
