/**
 * Soul Kernel — relational holograph (lens compilation).
 *
 * Identity is not global; it is refracted per interlocutor. A lens is the
 * refraction for one subject: which values to amplify and which evidence is
 * specific to that relationship. It is compiled MECHANICALLY — no model decides
 * how Talon shows up with Dylan vs. a stranger; the evidence does.
 *
 * The signal is provenance: evidence carries `source.actor`. A value that is
 * disproportionately built from a subject's evidence is amplified for that
 * subject, by a factor proportional to how much of the value is "theirs". The
 * lens also carries the subject-specific evidence verbatim.
 *
 * Re-compiling supersedes the prior lens for the same subject (a `supersedes`
 * edge), so exactly one live lens per subject survives — and superseded lenses
 * fall out of projection like any other superseded node.
 */

import { isSuperseded } from "./consolidate.js";
import type { SoulDag } from "./dag.js";
import type { EvidencePayload, Hash, ValuePayload } from "./types.js";

export interface LensOptions {
  readonly now: number;
  /** Max amplification boost for a fully subject-owned value (default 2). */
  readonly boost?: number;
  /** Cap on the number of subject-evidence fragments carried (default 12). */
  readonly maxEvidence?: number;
}

function actorOf(dag: SoulDag, evidence: Hash): string | undefined {
  const node = dag.getNode(evidence);
  return node?.payload.kind === "evidence"
    ? (node.payload as EvidencePayload).source.actor
    : undefined;
}

/** Live lens node for a subject, if one exists. */
export function liveLens(dag: SoulDag, subject: string): Hash | undefined {
  for (const node of dag.nodesOfKind("lens")) {
    if (
      node.payload.kind === "lens" &&
      node.payload.subject === subject &&
      !isSuperseded(dag, node.hash)
    ) {
      return node.hash;
    }
  }
  return undefined;
}

/**
 * Compile (or recompile) the lens for a subject from actor-tagged evidence.
 * Returns the lens hash, or undefined if the subject has no evidence. Caller
 * commits.
 */
export function compileLens(
  dag: SoulDag,
  subject: string,
  opts: LensOptions,
): Hash | undefined {
  const boost = opts.boost ?? 2;
  const maxEvidence = opts.maxEvidence ?? 12;

  // Subject-specific evidence.
  const subjectEvidence = dag
    .nodesOfKind("evidence")
    .filter((n) => actorOf(dag, n.hash) === subject)
    .map((n) => n.hash);
  if (subjectEvidence.length === 0) return undefined;
  const subjectSet = new Set(subjectEvidence);

  // Amplify values built disproportionately from the subject's evidence.
  const amplify: { node: Hash; factor: number }[] = [];
  for (const node of dag.nodesOfKind("value")) {
    if (isSuperseded(dag, node.hash)) continue;
    const value = node.payload as ValuePayload;
    const members = value.members.length ? value.members : [value.medoid];
    const owned = members.filter((m) => subjectSet.has(m)).length;
    if (owned === 0) continue;
    const factor = 1 + boost * (owned / members.length);
    amplify.push({ node: node.hash, factor });
  }

  const evidence = [...subjectEvidence].sort().slice(0, maxEvidence);
  const lens = dag.addNode(
    {
      kind: "lens",
      subject,
      amplify: amplify.sort((a, b) => a.node.localeCompare(b.node)),
      evidence,
    },
    opts.now,
  );

  // Supersede any prior live lens for this subject.
  for (const node of dag.nodesOfKind("lens")) {
    if (
      node.hash !== lens &&
      node.payload.kind === "lens" &&
      node.payload.subject === subject &&
      !isSuperseded(dag, node.hash)
    ) {
      const e = dag.edge(lens, "supersedes", node.hash, opts.now);
      e.weight = 1;
      e.updatedAt = opts.now;
    }
  }
  return lens;
}
