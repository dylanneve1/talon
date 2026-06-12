/**
 * textops-wasm — the Zig message-splitting core behind every
 * frontend's chunking (Telegram 4096, Discord 2000, Teams cards).
 * Exercises the TypeScript boundary (src/native/textops.ts) over the
 * embedded wasm: limit semantics, boundary preferences, fence
 * close/reopen, surrogate safety, and memory discipline.
 */

import { describe, expect, it } from "vitest";
import { splitMessage } from "../native/textops.js";

describe("splitMessage — fit and passthrough", () => {
  it("returns a short message as a single untouched chunk", () => {
    expect(splitMessage("Hello", 100)).toEqual(["Hello"]);
  });

  it("returns a fitting message verbatim, trailing whitespace included", () => {
    expect(splitMessage("hi \n", 100)).toEqual(["hi \n"]);
  });

  it("returns empty input as one empty chunk", () => {
    expect(splitMessage("", 10)).toEqual([""]);
  });

  it("discards trailing whitespace when the split eats the last separator", () => {
    const max = 10_000;
    const text = "A".repeat(max) + "\n\n";
    expect(splitMessage(text, max)).toEqual(["A".repeat(max)]);
  });
});

describe("splitMessage — boundary preference", () => {
  it("splits at paragraph breaks first", () => {
    const text = "a".repeat(60) + "\n\n" + "b".repeat(60);
    expect(splitMessage(text, 100)).toEqual(["a".repeat(60), "b".repeat(60)]);
  });

  it("splits at newlines when no paragraph break is in range", () => {
    const text = "a".repeat(60) + "\n" + "b".repeat(60);
    expect(splitMessage(text, 100)).toEqual(["a".repeat(60), "b".repeat(60)]);
  });

  it("splits at spaces when no newline is in range", () => {
    const chunks = splitMessage("word ".repeat(200), 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect(chunk.startsWith("word")).toBe(true);
    }
  });

  it("rejects separators in the first 30% of the limit", () => {
    // A newline at position 10 of a 100-char budget is a sliver — the
    // splitter should fall through to the space boundaries instead.
    const text = "ab cd efgh\n" + "word ".repeat(40);
    const chunks = splitMessage(text, 100);
    expect(chunks[0].length).toBeGreaterThan(30);
  });

  it("hard-cuts losslessly when there is no whitespace at all", () => {
    const text = "x".repeat(250);
    const chunks = splitMessage(text, 100);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunks.join("")).toBe(text);
  });
});

describe("splitMessage — UTF-16 unit accounting", () => {
  it("counts astral codepoints as two units like platform limits do", () => {
    // 120 emoji = 240 UTF-16 units; chunks must obey .length <= max.
    const chunks = splitMessage("😀".repeat(120), 51);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(51);
  });

  it("never splits inside a surrogate pair", () => {
    const chunks = splitMessage("😀".repeat(120), 51);
    for (const chunk of chunks) {
      // A lone surrogate would not survive a UTF-8 round trip.
      const roundTrip = new TextDecoder().decode(
        new TextEncoder().encode(chunk),
      );
      expect(roundTrip).toBe(chunk);
    }
    expect(chunks.join("")).toBe("😀".repeat(120));
  });

  it("makes progress even when the limit is below one astral codepoint", () => {
    const chunks = splitMessage("😀😀", 1);
    expect(chunks).toEqual(["😀", "😀"]);
  });
});

describe("splitMessage — code fences", () => {
  const block = "intro\n```js\n" + "const x = 1;\n".repeat(30) + "```\nafter";

  it("closes and reopens fences across chunk boundaries", () => {
    const chunks = splitMessage(block, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      // Every chunk renders as complete markup on its own.
      const fences = chunk.match(/^ {0,3}```/gm)?.length ?? 0;
      expect(fences % 2).toBe(0);
    }
    expect(chunks[1].startsWith("```\n")).toBe(true);
  });

  it("keeps decorated chunks within the limit, markers included", () => {
    // Regression for the old Discord splitter, which appended "\n```"
    // after cutting at the limit and could overflow it.
    const dense = "```\n" + "y".repeat(500) + "\n```";
    const chunks = splitMessage(dense, 100);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it("ignores inline triple-backtick runs", () => {
    // Regression for the old Discord splitter, which counted raw ```
    // occurrences: inline code spans flipped its fence state.
    const text = "use `````` to escape\n" + "word ".repeat(60);
    const chunks = splitMessage(text, 120);
    expect(chunks[0].endsWith("```")).toBe(false);
  });

  it("can be disabled", () => {
    const chunks = splitMessage(block, 120, { fenceAware: false });
    const reassembled = chunks.join("\n");
    expect(reassembled).not.toContain("```\n```");
    expect(chunks.some((c) => (c.match(/```/g)?.length ?? 0) % 2 === 1)).toBe(
      true,
    );
  });
});

describe("splitMessage — memory discipline", () => {
  it("returns identical results across many calls (no state leaks)", () => {
    const text = "word ".repeat(500) + "```\ncode\n" + "line\n".repeat(50);
    const first = splitMessage(text, 200);
    for (let i = 0; i < 1_000; i++) {
      expect(splitMessage(text, 200)).toEqual(first);
    }
  });

  it("handles large inputs", () => {
    const text = ("lorem ipsum dolor sit amet ".repeat(40) + "\n\n").repeat(
      100,
    );
    const chunks = splitMessage(text, 4096);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
    // Nothing but whitespace may be lost.
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(
      text.replace(/\s+/g, " ").trim(),
    );
  });
});
