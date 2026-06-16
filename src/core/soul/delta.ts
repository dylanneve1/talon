/**
 * Soul Kernel — the delta stream ("what changed in me, and why").
 *
 * One of the kernel's projection targets is a human-readable account of how the
 * soul changed between two versions. It is computed by diffing two DAG snapshots
 * and TEMPLATED from the structural difference — never model-written — so the
 * change log is as auditable as the identity itself. The kernel uses it to give
 * each commit a meaningful summary and to power a `/soul` introspection view.
 */

import type { DagSnapshot } from "./dag.js";
import type {
  Hash,
  NodePayload,
  SpinePayload,
  ThemePayload,
  ValuePayload,
} from "./types.js";

export interface SoulDelta {
  readonly addedValues: string[];
  readonly addedThemes: string[];
  readonly addedSpine: string[];
  readonly addedReflexes: string[];
  readonly addedLenses: string[];
  readonly supersededCount: number;
  readonly newTensions: number;
}

function payloadMap(snap: DagSnapshot): Map<Hash, NodePayload> {
  return new Map(snap.nodes.map((n) => [n.hash, n.payload]));
}

function evidenceText(map: Map<Hash, NodePayload>, hash: Hash): string {
  const p = map.get(hash);
  return p?.kind === "evidence" ? p.text : "";
}

function countEdges(snap: DagSnapshot, kind: string): number {
  return snap.edges.filter((e) => e.kind === kind).length;
}

/** Diff two snapshots into a structural delta. Append-only ⇒ only additions. */
export function diffSnapshots(prev: DagSnapshot, curr: DagSnapshot): SoulDelta {
  const prevHashes = new Set(prev.nodes.map((n) => n.hash));
  const map = payloadMap(curr);

  const addedValues: string[] = [];
  const addedThemes: string[] = [];
  const addedSpine: string[] = [];
  const addedReflexes: string[] = [];
  const addedLenses: string[] = [];

  for (const node of curr.nodes) {
    if (prevHashes.has(node.hash)) continue;
    const p = node.payload;
    switch (p.kind) {
      case "value":
        addedValues.push(evidenceText(map, (p as ValuePayload).medoid));
        break;
      case "theme":
        addedThemes.push(
          (p as ThemePayload).insight ??
            evidenceText(map, (p as ThemePayload).medoid),
        );
        break;
      case "spine":
        addedSpine.push((p as SpinePayload).event);
        break;
      case "reflex":
        addedReflexes.push(p.name);
        break;
      case "lens":
        addedLenses.push(p.subject);
        break;
      default:
        break;
    }
  }

  return {
    addedValues,
    addedThemes,
    addedSpine,
    addedReflexes,
    addedLenses,
    supersededCount:
      countEdges(curr, "supersedes") - countEdges(prev, "supersedes"),
    newTensions: countEdges(curr, "tension") - countEdges(prev, "tension"),
  };
}

/** Render a delta as a compact, templated one-paragraph summary. */
export function renderDelta(delta: SoulDelta): string {
  const parts: string[] = [];
  if (delta.addedValues.length)
    parts.push(`+${delta.addedValues.length} value(s)`);
  if (delta.addedThemes.length)
    parts.push(`+${delta.addedThemes.length} theme(s)`);
  if (delta.supersededCount > 0) parts.push(`${delta.supersededCount} merged`);
  if (delta.newTensions > 0) parts.push(`+${delta.newTensions} tension(s)`);
  if (delta.addedReflexes.length)
    parts.push(`+reflex ${delta.addedReflexes.join(", ")}`);
  if (delta.addedLenses.length)
    parts.push(`+lens ${delta.addedLenses.join(", ")}`);
  if (delta.addedSpine.length) parts.push(`+${delta.addedSpine.length} spine`);
  return parts.length ? parts.join(", ") : "no structural change";
}

/** A fuller multi-line introspection of the delta (for a `/soul` view). */
export function explainDelta(delta: SoulDelta): string {
  const lines: string[] = [];
  for (const v of delta.addedValues) lines.push(`+ value: "${v}"`);
  for (const t of delta.addedThemes) lines.push(`+ theme: ${t}`);
  for (const s of delta.addedSpine) lines.push(`+ spine: ${s}`);
  for (const r of delta.addedReflexes) lines.push(`+ reflex: ${r}`);
  for (const l of delta.addedLenses) lines.push(`+ lens: ${l}`);
  if (delta.supersededCount > 0)
    lines.push(`~ ${delta.supersededCount} value(s) merged away`);
  if (delta.newTensions > 0)
    lines.push(`~ ${delta.newTensions} new tension(s)`);
  return lines.length ? lines.join("\n") : "no structural change";
}
