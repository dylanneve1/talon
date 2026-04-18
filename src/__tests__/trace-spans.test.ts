import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub out filesystem writes — we only care about the in-memory ring buffer here.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

// Stub log.js so importing trace.js doesn't run module-level pino/file
// transport initialization (which would touch the real user home).
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  logTrace: vi.fn(),
  logFatal: vi.fn(),
}));

const { startSpan, withSpan, currentSpan, getRecentSpans, resetSpans } =
  await import("../util/trace.js");

describe("span tracing", () => {
  beforeEach(() => {
    resetSpans();
  });

  it("startSpan returns a span with trace + span ids", () => {
    const span = startSpan("test.op", { key: "value" });
    expect(span.traceId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{8}$/);
    expect(span.name).toBe("test.op");
    const rec = span.end();
    expect(rec.name).toBe("test.op");
    expect(rec.status).toBe("ok");
    expect(rec.attrs.key).toBe("value");
  });

  it("withSpan wraps a function and records duration + status", async () => {
    const rec = await withSpan("work", { kind: "test" }, async (span) => {
      span.addEvent("mid");
      span.setAttribute("answer", 42);
      return "ok";
    });
    expect(rec).toBe("ok");
    const [latest] = getRecentSpans(1);
    expect(latest.name).toBe("work");
    expect(latest.attrs.answer).toBe(42);
    expect(latest.events.map((e) => e.name)).toContain("mid");
    expect(latest.status).toBe("ok");
  });

  it("withSpan records errors and rethrows", async () => {
    await expect(
      withSpan("bad", undefined, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const [latest] = getRecentSpans(1);
    expect(latest.status).toBe("error");
    expect(latest.err).toBe("boom");
  });

  it("nested spans share traceId and link parent", async () => {
    let childTraceId = "";
    let childParentId = "";
    let parentSpanId = "";
    await withSpan("outer", undefined, async (outer) => {
      parentSpanId = outer.spanId;
      await withSpan("inner", undefined, async () => {
        const cur = currentSpan();
        childTraceId = cur?.traceId ?? "";
        // end() returns a record with parentSpanId
      });
      const spans = getRecentSpans(10);
      const inner = spans.find((s) => s.name === "inner");
      childParentId = inner?.parentSpanId ?? "";
    });
    const spans = getRecentSpans(10);
    const outer = spans.find((s) => s.name === "outer");
    expect(outer?.traceId).toBe(childTraceId);
    expect(childParentId).toBe(parentSpanId);
  });

  it("getRecentSpans caps the returned slice", async () => {
    for (let i = 0; i < 5; i++) {
      await withSpan(`op-${i}`, undefined, async () => i);
    }
    const last3 = getRecentSpans(3);
    expect(last3).toHaveLength(3);
    expect(last3[2].name).toBe("op-4");
  });

  it("normalizes JSON-hostile attributes so /debug/spans is exportable", async () => {
    const cyclic: Record<string, unknown> = { name: "node" };
    cyclic.self = cyclic;
    await withSpan("messy", undefined, (span) => {
      span.setAttribute("cycle", cyclic);
      span.setAttribute("big", 9999999999999999999n);
      span.setAttribute("fn", () => 0);
      span.addEvent("evt", { also_cyclic: cyclic });
      return null;
    });
    const [rec] = getRecentSpans(1);
    expect(rec.attrs.cycle).toEqual(
      expect.objectContaining({ name: "node", self: "[circular]" }),
    );
    expect(rec.attrs.big).toMatch(/n$/);
    expect(rec.attrs.fn).toMatch(/^\[Function/);
    expect(rec.events[0]?.attrs?.also_cyclic).toEqual(
      expect.objectContaining({ self: "[circular]" }),
    );
    // The whole record must round-trip through JSON.stringify, since that's
    // what /debug/spans and the spans-YYYY-MM-DD.jsonl writer call on it.
    expect(() => JSON.stringify(rec)).not.toThrow();
  });
});
