import { describe, it, expect } from "vitest";
import { toJsonSafe } from "../util/json-safe.js";

describe("toJsonSafe", () => {
  it("passes primitives through unchanged", () => {
    expect(toJsonSafe(null)).toBeNull();
    expect(toJsonSafe(true)).toBe(true);
    expect(toJsonSafe(false)).toBe(false);
    expect(toJsonSafe(42)).toBe(42);
    expect(toJsonSafe("hi")).toBe("hi");
  });

  it("flattens undefined to null (JSON has no undefined)", () => {
    expect(toJsonSafe(undefined)).toBeNull();
  });

  it("stringifies BigInt with trailing n marker", () => {
    expect(toJsonSafe(123n)).toBe("123n");
  });

  it("flattens NaN and Infinity to strings (JSON would emit null)", () => {
    expect(toJsonSafe(NaN)).toBe("NaN");
    expect(toJsonSafe(Infinity)).toBe("Infinity");
    expect(toJsonSafe(-Infinity)).toBe("-Infinity");
  });

  it("stringifies symbols and functions safely", () => {
    expect(toJsonSafe(Symbol("hi"))).toBe("Symbol(hi)");
    expect(toJsonSafe(function namedFn() {})).toBe("[Function namedFn]");
    // Arrow function has empty .name when assigned inline.
    expect(toJsonSafe(() => 0)).toMatch(/^\[Function/);
  });

  it("expands Errors into name/message/stack", () => {
    const err = new Error("boom");
    const safe = toJsonSafe(err) as Record<string, unknown>;
    expect(safe.name).toBe("Error");
    expect(safe.message).toBe("boom");
    expect(typeof safe.stack === "string" || safe.stack === undefined).toBe(
      true,
    );
  });

  it("converts Date to ISO string", () => {
    const d = new Date("2026-04-18T00:00:00.000Z");
    expect(toJsonSafe(d)).toBe("2026-04-18T00:00:00.000Z");
  });

  it("flags invalid Date", () => {
    expect(toJsonSafe(new Date(NaN))).toBe("[Invalid Date]");
  });

  it("flattens Map into __type/entries shape", () => {
    const m = new Map<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    const safe = toJsonSafe(m) as {
      __type: string;
      entries: [string, number][];
    };
    expect(safe.__type).toBe("Map");
    expect(safe.entries).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("flattens Set into __type/values shape", () => {
    const safe = toJsonSafe(new Set([1, 2, 3])) as {
      __type: string;
      values: unknown[];
    };
    expect(safe.__type).toBe("Set");
    expect(safe.values).toEqual([1, 2, 3]);
  });

  it("breaks circular references with marker (does not throw)", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const safe = toJsonSafe(a) as Record<string, unknown>;
    expect(safe.name).toBe("a");
    expect(safe.self).toBe("[circular]");
    // Final form must be JSON-serializable — that's the whole point.
    expect(() => JSON.stringify(safe)).not.toThrow();
  });

  it("caps deep recursion with [depth] marker", () => {
    // 12 levels deep, max depth default = 8 → at depth 8 we get [depth].
    const deep: Record<string, unknown> = { v: "leaf" };
    let cur = deep;
    for (let i = 0; i < 12; i++) {
      const next: Record<string, unknown> = {};
      cur.next = next;
      cur = next;
    }
    const safe = toJsonSafe(deep);
    const j = JSON.stringify(safe);
    expect(j).toContain('"[depth]"');
  });

  it("truncates long strings with overflow marker", () => {
    const big = "x".repeat(5000);
    const safe = toJsonSafe(big, { maxString: 16 }) as string;
    expect(safe.startsWith("xxxxxxxxxxxxxxxx")).toBe(true);
    expect(safe).toContain("[+");
  });

  it("caps array length and marks remainder", () => {
    const arr = Array.from({ length: 10 }, (_, i) => i);
    const safe = toJsonSafe(arr, { maxItems: 4 }) as unknown[];
    expect(safe.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(safe[4]).toMatch(/\+6 more/);
  });

  it("caps object key count and marks remainder", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 10; i++) obj[`k${i}`] = i;
    const safe = toJsonSafe(obj, { maxItems: 3 }) as Record<string, unknown>;
    expect(Object.keys(safe).length).toBe(4); // 3 keys + "…" overflow
    expect(safe["…"]).toMatch(/\+7 more keys/);
  });

  it("survives a getter that throws", () => {
    const obj = {
      good: 1,
      get bad(): number {
        throw new Error("nope");
      },
    };
    const safe = toJsonSafe(obj) as Record<string, unknown>;
    expect(safe.good).toBe(1);
    expect(safe.bad).toBe("[unserializable]");
  });

  it("describes typed arrays with byte-length preview, not full payload", () => {
    const buf = Buffer.from("hello world");
    const safe = toJsonSafe(buf) as string;
    expect(safe).toMatch(/^\[Buffer .*bytes=11\]$/);
  });

  it("output is always JSON.stringify-safe (random nasty mix)", () => {
    const messy: Record<string, unknown> = {
      big: 9999999999999999999n,
      sym: Symbol("x"),
      fn: () => 0,
      nan: NaN,
      inf: Infinity,
      err: new TypeError("nope"),
      d: new Date("2026-01-01T00:00:00Z"),
      m: new Map([["k", "v"]]),
      s: new Set([1]),
      bytes: new Uint8Array([1, 2, 3]),
    };
    messy.cycle = messy;
    const safe = toJsonSafe(messy);
    expect(() => JSON.stringify(safe)).not.toThrow();
  });
});
