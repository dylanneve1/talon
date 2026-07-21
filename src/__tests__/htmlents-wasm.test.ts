/**
 * htmlents-wasm — the Rust HTML entity escaper behind every Telegram
 * HTML render (frontend/telegram/formatting.ts). Exercises the
 * TypeScript boundary (src/native/htmlents.ts) over the embedded wasm:
 * the exact entity set, UTF-8 passthrough, a property check against
 * the JS implementation it replaced, and memory discipline.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { escapeHtml } from "../native/htmlents.js";

/** The JS implementation this module replaced — the semantic contract. */
function referenceEscapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

describe("escapeHtml", () => {
  it("escapes the five HTML special characters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });

  it("passes clean text through untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
    expect(escapeHtml("")).toBe("");
  });

  it("escapes & first-class — no double escaping", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
    expect(escapeHtml("&&&")).toBe("&amp;&amp;&amp;");
  });

  it("passes multi-byte UTF-8 through untouched", () => {
    expect(escapeHtml("héllo 🚀 日本語")).toBe("héllo 🚀 日本語");
    expect(escapeHtml("🚀<🚀")).toBe("🚀&lt;🚀");
  });

  it("matches the JS implementation it replaced on arbitrary inputs", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (text) => {
        expect(escapeHtml(text)).toBe(referenceEscapeHtml(text));
      }),
    );
  });

  it("handles large inputs in one pass", () => {
    const big = `<b>${"x".repeat(100_000)}&</b>`;
    expect(escapeHtml(big)).toBe(referenceEscapeHtml(big));
  });

  it("stays correct across thousands of repeated calls", () => {
    for (let i = 0; i < 5000; i++) {
      expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
    }
  });
});
