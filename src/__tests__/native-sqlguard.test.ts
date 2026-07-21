import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { escapeLike, ftsQuote } from "../native/sqlguard.js";

/**
 * sqlguard (native/sqlguard-wasm) replaces hand-rolled JS escaping that fed
 * model/attacker-controlled text into SQLite queries. These reference
 * implementations are the *exact* original JS — the bar is byte-for-byte
 * equality, so the transition is a pure refactor with no behaviour change.
 *
 *   escapeLike  ← history-repo.ts bySenderName (LIKE wildcard escaping)
 *   ftsQuote    ← history.ts ftsQuery (FTS5 MATCH quoting)
 */
const refEscapeLike = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");

const refFtsQuote = (q: string): string =>
  q
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" ");

// Every codepoint ECMAScript `\s` matches (fixed set, version-stable).
const WHITESPACE_CODEPOINTS = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028,
  0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

describe("escapeLike", () => {
  it("escapes the LIKE wildcards for an ESCAPE '\\' clause", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("back\\slash")).toBe("back\\\\slash");
    // backslash escaped first, so added escapes are not double-escaped
    expect(escapeLike("%_\\")).toBe("\\%\\_\\\\");
  });

  it("lowercases before escaping (matching the original)", () => {
    expect(escapeLike("ALICE")).toBe("alice");
    expect(escapeLike("Bob_99%")).toBe("bob\\_99\\%");
  });

  it("passes plain text and multi-byte UTF-8 through unchanged", () => {
    expect(escapeLike("hello world")).toBe("hello world");
    expect(escapeLike("café 你好 🎉")).toBe("café 你好 🎉");
  });

  it("preserves a leading BOM (U+FEFF) like the JS it replaces", () => {
    expect(escapeLike("﻿_x")).toBe("﻿\\_x");
  });

  it("returns empty string for empty input", () => {
    expect(escapeLike("")).toBe("");
  });
});

describe("ftsQuote", () => {
  it("quotes each whitespace-delimited token", () => {
    expect(ftsQuote("hello world")).toBe('"hello" "world"');
    expect(ftsQuote("single")).toBe('"single"');
  });

  it("neutralises FTS operators by quoting them as literals", () => {
    expect(ftsQuote("foo AND bar")).toBe('"foo" "AND" "bar"');
    expect(ftsQuote("a NEAR b*")).toBe('"a" "NEAR" "b*"');
  });

  it("doubles interior double-quotes", () => {
    expect(ftsQuote('say "hi"')).toBe('"say" """hi"""');
  });

  it("collapses leading/trailing/repeated whitespace (filter Boolean)", () => {
    expect(ftsQuote("   spaced   out   ")).toBe('"spaced" "out"');
    expect(ftsQuote("\t\ttabbed\n")).toBe('"tabbed"');
  });

  it("returns empty string for empty / all-whitespace input", () => {
    expect(ftsQuote("")).toBe("");
    expect(ftsQuote("   \t\n  ")).toBe("");
  });

  it("splits on every ECMAScript \\s codepoint exactly like /\\s+/", () => {
    for (const cp of WHITESPACE_CODEPOINTS) {
      const s = `a${String.fromCodePoint(cp)}b`;
      expect(ftsQuote(s)).toBe(refFtsQuote(s));
      expect(ftsQuote(s)).toBe('"a" "b"');
    }
  });

  it("does NOT split on U+200B (zero-width space — not in \\s)", () => {
    expect(ftsQuote("a​b")).toBe(refFtsQuote("a​b"));
    expect(ftsQuote("a​b")).toBe('"a​b"');
  });
});

// ── Differential: native output must equal the original JS, byte for byte ──

// A charset that densely stresses the escaping/tokenising logic: every \s
// codepoint, the metacharacters, quotes, multi-byte letters, and a non-\s
// zero-width space (U+200B) that must NOT be treated as whitespace.
const MIXED_CHARSET = [
  ...WHITESPACE_CODEPOINTS,
  // metacharacters: a b _ % \ " ' < > & *
  0x61,
  0x62,
  0x5f,
  0x25,
  0x5c,
  0x22,
  0x27,
  0x3c,
  0x3e,
  0x26,
  0x2a,
  // multi-byte letters + en-dash + emoji + a non-\s zero-width space (U+200B)
  0xe9,
  0x4f60,
  0x597d,
  0x2013,
  0x1f389,
  0x200b,
].map((cp) => String.fromCodePoint(cp));

const mixed = fc
  .array(fc.constantFrom(...MIXED_CHARSET), { maxLength: 24 })
  .map((chars) => chars.join(""));

describe("sqlguard differential (native === original JS)", () => {
  it("escapeLike matches the reference on stress charset", () => {
    fc.assert(
      fc.property(mixed, (s) => {
        expect(escapeLike(s)).toBe(refEscapeLike(s));
      }),
      { numRuns: 5000 },
    );
  });

  it("ftsQuote matches the reference on stress charset", () => {
    fc.assert(
      fc.property(mixed, (s) => {
        expect(ftsQuote(s)).toBe(refFtsQuote(s));
      }),
      { numRuns: 5000 },
    );
  });

  it("both match the reference on arbitrary Unicode strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        expect(escapeLike(s)).toBe(refEscapeLike(s));
        expect(ftsQuote(s)).toBe(refFtsQuote(s));
      }),
      { numRuns: 3000 },
    );
  });
});
