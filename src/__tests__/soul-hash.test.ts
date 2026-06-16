/**
 * Tests for content addressing — the bedrock of the kernel. If hashing is not
 * deterministic and order-stable, every higher layer (dedup, provenance,
 * rollback) silently breaks, so these are deliberately exhaustive.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalize,
  hashContent,
  hashPayload,
  isHash,
  merkleRoot,
} from "../core/soul/hash.js";
import type { EvidencePayload, Hash } from "../core/soul/types.js";

describe("canonicalize", () => {
  it("sorts object keys regardless of insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("drops undefined object values but keeps nulls", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it("rejects unserializable leaves", () => {
    expect(() => canonicalize(() => 0)).toThrow(TypeError);
    expect(() => canonicalize(10n)).toThrow(TypeError);
  });

  it("nests deterministically", () => {
    const a = canonicalize({ x: { q: 1, p: 2 }, y: [{ b: 1, a: 0 }] });
    const b = canonicalize({ y: [{ a: 0, b: 1 }], x: { p: 2, q: 1 } });
    expect(a).toBe(b);
  });
});

describe("hashContent", () => {
  it("is stable and prefixed", () => {
    const h = hashContent({ hello: "world" });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashContent({ hello: "world" })).toBe(h);
  });

  it("is insensitive to key order, sensitive to values", () => {
    expect(hashContent({ a: 1, b: 2 })).toBe(hashContent({ b: 2, a: 1 }));
    expect(hashContent({ a: 1 })).not.toBe(hashContent({ a: 2 }));
  });
});

describe("hashPayload", () => {
  it("gives identical evidence the same identity (dedup)", () => {
    const mk = (): EvidencePayload => ({
      kind: "evidence",
      text: "just be grounded and talk naturally",
      observedAt: 1_700_000_000_000,
      source: { origin: "directive", actor: "dylan" },
    });
    expect(hashPayload(mk())).toBe(hashPayload(mk()));
  });

  it("distinguishes evidence observed at different times", () => {
    const base: EvidencePayload = {
      kind: "evidence",
      text: "x",
      observedAt: 1,
      source: { origin: "event" },
    };
    expect(hashPayload(base)).not.toBe(hashPayload({ ...base, observedAt: 2 }));
  });
});

describe("merkleRoot", () => {
  it("is order-independent over the child set", () => {
    const a = "sha256:" + "a".repeat(64);
    const b = "sha256:" + "b".repeat(64);
    expect(merkleRoot([a, b] as Hash[])).toBe(merkleRoot([b, a] as Hash[]));
  });

  it("changes when the set changes", () => {
    const a = "sha256:" + "a".repeat(64);
    const b = "sha256:" + "b".repeat(64);
    expect(merkleRoot([a] as Hash[])).not.toBe(merkleRoot([a, b] as Hash[]));
  });
});

describe("isHash", () => {
  it("accepts well-formed addresses and rejects junk", () => {
    expect(isHash("sha256:" + "0".repeat(64))).toBe(true);
    expect(isHash("sha256:xyz")).toBe(false);
    expect(isHash("0".repeat(64))).toBe(false);
    expect(isHash(42)).toBe(false);
  });
});
