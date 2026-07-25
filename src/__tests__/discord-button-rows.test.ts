/**
 * Discord inline-button construction.
 *
 * `buildButtonRows` feeds discord.js builders, whose validators throw
 * synchronously. A throw here escapes before anything is sent, so a single
 * malformed button used to discard the reply TEXT as well as every other
 * button — the model's whole answer, lost, with an uninterpretable error.
 * Each case below is one of those.
 */

import { describe, it, expect } from "vitest";
import { buildButtonRows } from "../frontend/discord/actions/shared.js";
import { safeSlice } from "../frontend/discord/formatting.js";

type Btn = {
  text: string;
  url?: string;
  callback_data?: string;
  style?: string;
};

/** custom_id / url of every button, flattened. */
function idsOf(rows: Btn[][]): string[] {
  return buildButtonRows(rows).flatMap((row) =>
    row.components.map(
      (c) =>
        (c.data as { custom_id?: string; url?: string }).custom_id ??
        (c.data as { url?: string }).url ??
        "",
    ),
  );
}

describe("safeSlice", () => {
  // Discord and discord.js both measure String.length (UTF-16 units).
  // Slicing by code point overshoots for astral characters: 80 code points
  // of emoji is 160 units, so the guard passed and the send then threw.
  it("limits by UTF-16 length, not code points", () => {
    const emoji = "🎉".repeat(60); // 60 code points, 120 units
    expect(safeSlice(emoji, 80).length).toBeLessThanOrEqual(80);
  });

  it("never splits a surrogate pair", () => {
    // An odd budget forces the boundary mid-pair if the code is naive.
    const out = safeSlice("🎉".repeat(10), 7);
    expect(out).not.toContain("�");
    expect([...out].every((c) => c === "🎉")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(7);
  });

  it("leaves strings within budget untouched", () => {
    expect(safeSlice("hello", 80)).toBe("hello");
  });
});

describe("buildButtonRows", () => {
  it("accepts an astral label that exceeds 80 UTF-16 units", () => {
    const label =
      "📊 Show me the full quarterly revenue breakdown by region and product line for FY25 📈";
    expect(label.length).toBeGreaterThan(80);
    expect(() => buildButtonRows([[{ text: label }]])).not.toThrow();
  });

  it("accepts astral callback_data beyond the custom_id budget", () => {
    expect(() =>
      buildButtonRows([[{ text: "go", callback_data: "🎉".repeat(60) }]]),
    ).not.toThrow();
  });

  it("keeps every custom_id within Discord's 100-unit cap", () => {
    for (const raw of ["🎉".repeat(60), "x".repeat(200), "あ".repeat(80)]) {
      for (const id of idsOf([[{ text: "b", callback_data: raw }]])) {
        expect(id.length).toBeLessThanOrEqual(100);
      }
    }
  });

  // A bare domain is a common model output, and used to take the whole
  // message down with it.
  it("downgrades a scheme-less URL to a normal button instead of throwing", () => {
    const ids = idsOf([[{ text: "Docs", url: "docs.example.com/guide" }]]);
    expect(ids).toEqual(["ai:Docs"]);
  });

  it("downgrades a javascript: URL rather than failing the send", () => {
    const ids = idsOf([[{ text: "go", url: "javascript:alert(1)" }]]);
    expect(ids).toEqual(["ai:go"]);
  });

  it("still renders a real https link as a Link button", () => {
    expect(idsOf([[{ text: "Docs", url: "https://example.com" }]])).toEqual([
      "https://example.com",
    ]);
  });

  // Discord requires >= 1 component per action row.
  it("drops empty rows", () => {
    expect(buildButtonRows([[]])).toHaveLength(0);
    expect(buildButtonRows([[], [{ text: "a" }]])).toHaveLength(1);
  });

  // custom_id must be unique per message. Two blank labels both collapsed
  // to the bare "ai:" prefix.
  it("de-duplicates colliding custom_ids", () => {
    expect(idsOf([[{ text: "" }, { text: "" }]])).toEqual(["ai:", "ai:#2"]);
    expect(idsOf([[{ text: "Yes" }, { text: "Yes" }]])).toEqual([
      "ai:Yes",
      "ai:Yes#2",
    ]);
  });

  it("keeps de-duplicated ids inside the cap", () => {
    const raw = "x".repeat(200);
    for (const id of idsOf([
      [
        { text: "a", callback_data: raw },
        { text: "b", callback_data: raw },
      ],
    ])) {
      expect(id.length).toBeLessThanOrEqual(100);
    }
  });

  it("still honours Discord's 5-per-row and 5-row caps", () => {
    const row = Array.from({ length: 9 }, (_, i) => ({ text: `b${i}` }));
    const built = buildButtonRows(Array.from({ length: 9 }, () => row));
    expect(built).toHaveLength(5);
    for (const r of built) expect(r.components).toHaveLength(5);
  });
});
