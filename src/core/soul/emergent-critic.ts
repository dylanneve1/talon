/**
 * Soul Kernel — the emergent critic.
 *
 * The lexical Critic (critic.ts) hardcodes three failure modes and their word
 * lists. That is a useful bootstrap, but it is exactly the kind of "overly
 * programmed and specific" thing the soul should grow past. The emergent critic
 * derives failure modes from data: corrections carry negative valence, and
 * clusters of corrections ARE the failure modes — discovered, not declared.
 *
 * To assess a candidate reply, embed it and measure its proximity to those
 * correction clusters. If it lands near a cluster of past corrections, it is at
 * risk of repeating that mistake — and the warning is a real past correction
 * (the cluster's medoid), not an invented category. As Dylan corrects Talon, new
 * failure modes appear on their own; nothing here is hand-authored.
 */

import { clusterEvidence } from "./cluster.js";
import type { SoulDag } from "./dag.js";
import { cosineDistance, type Embedder } from "./embedder.js";
import type { EvidencePayload, Hash } from "./types.js";

export interface EmergentFailureMode {
  /** A real past correction representing the cluster — never generated. */
  readonly label: string;
  readonly medoid: Hash;
  readonly centroid: readonly number[];
  /** Number of corrections in this mode. */
  readonly size: number;
}

export interface FailureRisk {
  readonly label: string;
  readonly distance: number;
  readonly atRisk: boolean;
}

function correctionEvidence(dag: SoulDag): { hash: Hash; text: string }[] {
  const out: { hash: Hash; text: string }[] = [];
  for (const node of dag.nodesOfKind("evidence")) {
    const p = node.payload as EvidencePayload;
    if (p.source.origin === "correction")
      out.push({ hash: node.hash, text: p.text });
  }
  return out;
}

/**
 * Derive failure modes by clustering Talon's actual corrections. `threshold` is
 * the cluster tightness; each resulting cluster is one emergent failure mode,
 * labeled by its medoid (a representative real correction).
 */
export async function deriveFailureModes(
  dag: SoulDag,
  embedder: Embedder,
  threshold: number,
): Promise<EmergentFailureMode[]> {
  const corrections = correctionEvidence(dag);
  if (corrections.length === 0) return [];

  const vectors = await embedder.embed(corrections.map((c) => c.text));
  const embedded = corrections.map((c, i) => ({
    hash: c.hash,
    vector: vectors[i]!,
  }));
  const clusters = clusterEvidence(embedded, threshold);

  const textByHash = new Map(corrections.map((c) => [c.hash, c.text]));
  return clusters.map((cl) => ({
    label: textByHash.get(cl.medoid) ?? "",
    medoid: cl.medoid,
    centroid: cl.centroid,
    size: cl.members.length,
  }));
}

/**
 * Assess a candidate reply against the emergent failure modes. Returns the risk
 * per mode (sorted nearest first); `atRisk` when the candidate sits within
 * `riskDistance` of a correction cluster — i.e. it resembles something Talon was
 * already corrected for.
 */
export async function assessText(
  text: string,
  modes: readonly EmergentFailureMode[],
  embedder: Embedder,
  riskDistance: number,
): Promise<FailureRisk[]> {
  if (modes.length === 0) return [];
  const [vec] = await embedder.embed([text]);
  return modes
    .map((m) => {
      const distance = cosineDistance(vec!, m.centroid);
      return { label: m.label, distance, atRisk: distance <= riskDistance };
    })
    .sort((a, b) => a.distance - b.distance);
}
