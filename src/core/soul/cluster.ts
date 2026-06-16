/**
 * Soul Kernel — emergent value clustering.
 *
 * This is where values *come from*: not authored, not seeded by a model, but
 * discovered as clusters of evidence embeddings. The model never names a value —
 * the cluster's medoid (its most central real fragment) is its label.
 *
 * The algorithm is single-pass leader/threshold clustering: each item joins the
 * nearest existing cluster if it is within `threshold` cosine distance of that
 * cluster's centroid, otherwise it founds a new cluster. Leader clustering is
 * order-sensitive, so items are processed in a stable hash order to keep the
 * output deterministic and reproducible across runs.
 */

import { centroid, cosineDistance, medoidIndex } from "./embedder.js";
import type { Hash } from "./types.js";

export interface Embedded {
  readonly hash: Hash;
  readonly vector: readonly number[];
}

export interface EvidenceCluster {
  /** Evidence hashes in the cluster, in stable order. */
  readonly members: Hash[];
  /** The medoid evidence hash — the value's verbatim label. */
  readonly medoid: Hash;
  /** Cluster centroid, for downstream distance comparisons. */
  readonly centroid: number[];
}

interface MutableCluster {
  members: Hash[];
  vectors: number[][];
  centroid: number[];
}

/**
 * Cluster embedded evidence into emergent groups. `threshold` is the maximum
 * cosine distance for an item to join a cluster (smaller = tighter, more
 * clusters). Processing order is stabilized by hash so results are deterministic.
 */
export function clusterEvidence(
  items: readonly Embedded[],
  threshold: number,
): EvidenceCluster[] {
  const sorted = [...items].sort((a, b) => a.hash.localeCompare(b.hash));
  const clusters: MutableCluster[] = [];

  for (const item of sorted) {
    let nearest = -1;
    let nearestDist = Infinity;
    for (let c = 0; c < clusters.length; c++) {
      const d = cosineDistance(item.vector, clusters[c]!.centroid);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = c;
      }
    }

    if (nearest >= 0 && nearestDist <= threshold) {
      const cl = clusters[nearest]!;
      cl.members.push(item.hash);
      cl.vectors.push([...item.vector]);
      cl.centroid = centroid(cl.vectors);
    } else {
      clusters.push({
        members: [item.hash],
        vectors: [[...item.vector]],
        centroid: [...item.vector],
      });
    }
  }

  return clusters.map((cl) => {
    const mi = medoidIndex(cl.vectors);
    return {
      members: cl.members,
      medoid: cl.members[mi]!,
      centroid: cl.centroid,
    };
  });
}
