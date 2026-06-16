/**
 * Content addressing for the Soul kernel.
 *
 * A node's identity is the sha-256 of its *canonical* serialization. Canonical
 * means: deterministic key ordering, no whitespace, explicit rejection of
 * non-data values. Two nodes with semantically identical content therefore hash
 * identically — which is what makes dedup, provenance, and partial recompilation
 * structural rather than bolted-on.
 *
 * Only CONTENT is ever hashed here. Mutable state (salience, edge weights) is
 * deliberately excluded from node identity (see types.ts).
 */

import { createHash } from "node:crypto";
import type { Hash, NodePayload } from "./types.js";

/**
 * Canonical JSON: object keys sorted lexicographically, arrays preserved in
 * order, no insignificant whitespace. Rejects `undefined`, functions, symbols,
 * NaN and ±Infinity so a hash can never depend on an unserializable value.
 *
 * This is intentionally stricter than JSON.stringify: we want a single
 * canonical byte string per logical value, and we want loud failure on anything
 * that could silently vary.
 */
export function canonicalize(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "string") return JSON.stringify(value);

  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`canonicalize: non-finite number ${String(value)}`);
    }
    return JSON.stringify(value);
  }

  if (t === "boolean") return value ? "true" : "false";

  if (t === "bigint") {
    throw new TypeError("canonicalize: bigint is not serializable");
  }

  if (Array.isArray(value)) {
    return `[${value.map(encode).join(",")}]`;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      // Drop keys whose value is undefined, mirroring JSON semantics, but only
      // for objects — undefined inside arrays is rejected below.
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encode(v)}`);
    }
    return `{${parts.join(",")}}`;
  }

  // undefined, function, symbol
  throw new TypeError(`canonicalize: cannot serialize ${t}`);
}

/** sha-256 of an arbitrary canonicalized value, prefixed "sha256:". */
export function hashContent(value: unknown): Hash {
  const canonical = canonicalize(value);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${digest}` as Hash;
}

/** The content address of a node payload. This is the node's identity. */
export function hashPayload(payload: NodePayload): Hash {
  return hashContent(payload);
}

/**
 * A Merkle root over a set of child hashes. Order-independent: the children are
 * sorted before hashing, so the root depends only on the *set* of content
 * present, not the order it was inserted. This is the structural version id.
 */
export function merkleRoot(childHashes: Iterable<Hash>): Hash {
  const sorted = [...childHashes].sort();
  return hashContent({ merkle: sorted });
}

/** True when a string is a well-formed kernel content address. */
export function isHash(value: unknown): value is Hash {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
