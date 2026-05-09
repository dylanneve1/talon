/**
 * Extended branch coverage for src/util/log.ts.
 *
 * Covers uncovered branches in redactValue / serializeError / readErrorString
 * that are not exercised by the existing log.test.ts:
 *
 *   - null / undefined field value (redactValue line 144 true-branch)
 *   - bigint field value  (line 152)
 *   - symbol field value  (line 153)
 *   - function field value (line 154)
 *   - max-depth truncation (line 155, depth >= 5)
 *   - Error nested inside fields (line 156)
 *   - circular-reference detection (line 158)
 *   - Array field value   (line 161)
 *   - readErrorString returning a truthy string (line 184 cond-expr true-branch)
 */

import { describe, it, expect, vi } from "vitest";

const mockInfo = vi.fn();
const mockError = vi.fn();
const mockWarn = vi.fn();
const mockDebug = vi.fn();

vi.mock("pino", () => ({
  default: () => ({
    info: mockInfo,
    error: mockError,
    warn: mockWarn,
    debug: mockDebug,
  }),
}));

const { log, logError } = await import("../util/log.js");

describe("log — extended redactValue / serializeError branch coverage", () => {
  it("passes null field value through unchanged", () => {
    log("bot", "null field", { nullField: null });
    const call = mockInfo.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.nullField).toBeNull();
  });

  it("converts bigint field values to strings", () => {
    log("bot", "bigint field", { n: BigInt(42) });
    const call = mockInfo.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.n).toBe("42");
  });

  it("converts symbol field values to strings", () => {
    log("bot", "symbol field", { s: Symbol("test") });
    const call = mockInfo.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(typeof call.s).toBe("string");
    expect((call.s as string).startsWith("Symbol")).toBe(true);
  });

  it("replaces function field values with [function]", () => {
    log("bot", "function field", { fn: () => "noop" });
    const call = mockInfo.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.fn).toBe("[function]");
  });

  it("truncates fields that exceed max depth with [max-depth]", () => {
    // MAX_LOG_FIELD_DEPTH = 5 — six levels of nesting hits the guard at depth 5
    log("bot", "deep field", {
      l1: { l2: { l3: { l4: { l5: { l6: "too deep" } } } } },
    });
    const raw = mockInfo.mock.calls.at(-1)![0] as Record<string, unknown>;
    const l1 = raw.l1 as Record<string, unknown>;
    const l2 = l1.l2 as Record<string, unknown>;
    const l3 = l2.l3 as Record<string, unknown>;
    const l4 = l3.l4 as Record<string, unknown>;
    // At depth 5 the entire sub-object is replaced with "[max-depth]"
    expect(l4.l5).toBe("[max-depth]");
  });

  it("serialises an Error nested inside fields", () => {
    log("bot", "nested error", { cause: new Error("inner failure") });
    const call = mockInfo.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.cause).toMatchObject({
      type: "Error",
      message: "inner failure",
    });
  });

  it("replaces circular field references with [circular]", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj; // circular
    log("bot", "circular field", obj);
    const call = mockInfo.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.self).toBe("[circular]");
  });

  it("maps over Array field values", () => {
    log("bot", "array field", { items: [1, 2, 3] });
    const call = mockInfo.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.items).toEqual([1, 2, 3]);
  });

  it("uses readErrorString to extract name/code from plain-object errors", () => {
    // A plain object with a 'name' property exercises the truthy-string return
    // path of readErrorString (line 184 cond-expr true-branch).
    logError("bot", "plain object error", {
      name: "NetworkError",
      code: "ECONNREFUSED",
    });
    const call = mockError.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.err).toMatchObject({ type: "NetworkError" });
  });
});
