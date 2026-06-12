/**
 * strsim-wasm — the C string-similarity core behind "did you mean ...?"
 * suggestions (unknown Telegram slash commands, unknown CLI
 * subcommands). Exercises the TypeScript boundary (src/native/strsim.ts)
 * over the embedded wasm: known distances, a property check against a
 * JS reference implementation, the 1024-byte ceiling, closestMatch
 * semantics, and memory discipline.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { closestMatch, levenshtein } from "../native/strsim.js";

/** Reference implementation — classic two-row DP over UTF-8 bytes. */
function referenceLevenshtein(aStr: string, bStr: string): number {
  const a = new TextEncoder().encode(aStr);
  const b = new TextEncoder().encode(bStr);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        prev[j] + 1,
        curr[j - 1] + 1,
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

describe("levenshtein", () => {
  it("computes textbook distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("flaw", "lawn")).toBe(2);
    expect(levenshtein("doctor", "doctor")).toBe(0);
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("counts UTF-8 byte edits for non-ASCII text", () => {
    // é is two bytes — replacing it with the one-byte "e" is one
    // substitution plus one deletion at the byte level.
    expect(levenshtein("héllo", "hello")).toBe(2);
  });

  it("matches a JS reference implementation on arbitrary inputs", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 64 }),
        fc.string({ maxLength: 64 }),
        (a, b) => {
          expect(levenshtein(a, b)).toBe(referenceLevenshtein(a, b));
        },
      ),
    );
  });

  it("throws past the 1024-byte ceiling instead of guessing", () => {
    expect(() => levenshtein("a".repeat(1025), "b")).toThrow(/1024/);
    // Exactly at the ceiling still works.
    expect(levenshtein("a".repeat(1024), "a".repeat(1024))).toBe(0);
  });

  it("stays correct across thousands of repeated calls", () => {
    for (let i = 0; i < 5000; i++) {
      expect(levenshtein("doctor", "docter")).toBe(1);
    }
  });
});

describe("closestMatch", () => {
  const commands = ["doctor", "dream", "status", "settings", "metrics"];

  it("finds the nearest candidate within the default distance", () => {
    expect(closestMatch("docter", commands)).toEqual({
      value: "doctor",
      distance: 1,
    });
    expect(closestMatch("stats", commands)).toEqual({
      value: "status",
      distance: 1,
    });
  });

  it("matches case-insensitively but returns original casing", () => {
    expect(closestMatch("DOCTOR", commands)).toEqual({
      value: "doctor",
      distance: 0,
    });
  });

  it("returns null when nothing is close enough", () => {
    expect(closestMatch("zzzzzz", commands)).toBeNull();
    expect(closestMatch("doctor", [])).toBeNull();
  });

  it("prefers the first candidate on ties", () => {
    expect(closestMatch("ab", ["abc", "abd"])).toEqual({
      value: "abc",
      distance: 1,
    });
  });

  it("respects a custom maxDistance", () => {
    expect(closestMatch("docter", commands, 0)).toBeNull();
    expect(closestMatch("statu", commands, 1)).toEqual({
      value: "status",
      distance: 1,
    });
  });

  it("skips oversized candidates instead of failing the whole scan", () => {
    expect(closestMatch("doctor", ["x".repeat(2000), "docter"])).toEqual({
      value: "docter",
      distance: 1,
    });
  });
});
