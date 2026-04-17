/**
 * Tracing — two complementary tools for debugging Talon.
 *
 * 1. traceMessage(): per-chat message dump to ~/.talon/data/traces/<chatId>.jsonl
 *    (unchanged historical API — used by the Claude handler)
 *
 * 2. Spans: lightweight, OpenTelemetry-inspired spans for tracking latency and
 *    causality across async code. Spans are stored in an in-memory ring buffer
 *    (exposed via /debug/spans) and appended to
 *    ~/.talon/data/traces/spans-YYYY-MM-DD.jsonl for post-mortem analysis.
 *
 *    Usage:
 *      await withSpan("dispatcher.run", { chatId }, async (span) => {
 *        span.setAttribute("model", "sonnet");
 *        span.addEvent("typing-started");
 *        return doWork();
 *      });
 *
 *    AsyncLocalStorage propagates the current span across awaits so child
 *    spans link to their parent automatically.
 *
 *    Persistence (spans-YYYY-MM-DD.jsonl) is opt-in via TALON_TRACE_PERSIST=1
 *    because every span.end() would otherwise issue a blocking appendFileSync
 *    from hot code paths (dispatcher, gateway). The in-memory ring buffer and
 *    auto-emitted metrics are always available.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { dirs } from "./paths.js";
import { logError } from "./log.js";
import { recordHistogram, incrementCounter } from "./metrics.js";

function ensureDir(): void {
  if (!existsSync(dirs.traces)) mkdirSync(dirs.traces, { recursive: true });
}

// ── Legacy per-chat message trace (unchanged) ────────────────────────────────

export function traceMessage(
  chatId: string,
  direction: "in" | "out",
  text: string,
  meta?: Record<string, unknown>,
): void {
  try {
    ensureDir();
    const entry = {
      ts: new Date().toISOString(),
      dir: direction,
      text,
      ...meta,
    };
    appendFileSync(
      resolve(dirs.traces, `${chatId}.jsonl`),
      JSON.stringify(entry) + "\n",
    );
  } catch (err) {
    process.stderr.write(
      `[trace] Trace write failed: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

// ── Span-based tracing ────────────────────────────────────────────────────────

export type SpanStatus = "ok" | "error";

export type SpanAttributes = Record<string, unknown>;

export type SpanEvent = {
  ts: number;
  name: string;
  attrs?: SpanAttributes;
};

export type SpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: SpanStatus;
  attrs: SpanAttributes;
  events: SpanEvent[];
  err?: string;
};

export type Span = {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  setAttribute: (key: string, value: unknown) => void;
  setAttributes: (attrs: SpanAttributes) => void;
  addEvent: (name: string, attrs?: SpanAttributes) => void;
  setStatus: (status: SpanStatus, err?: unknown) => void;
  end: () => SpanRecord;
};

const SPAN_RING_SIZE = 1000;
// Fixed-size circular buffer — O(1) insert, no Array#shift cost under load.
const recentSpans: SpanRecord[] = new Array<SpanRecord>(SPAN_RING_SIZE);
let recentSpansHead = 0; // next write position
let recentSpansSize = 0; // valid entries (≤ capacity)
const SPAN_LOG_PREFIX = "spans";

function pushSpan(rec: SpanRecord): void {
  recentSpans[recentSpansHead] = rec;
  recentSpansHead = (recentSpansHead + 1) % SPAN_RING_SIZE;
  if (recentSpansSize < SPAN_RING_SIZE) recentSpansSize++;
}

function currentLogFile(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return resolve(dirs.traces, `${SPAN_LOG_PREFIX}-${y}-${m}-${day}.jsonl`);
}

const persistEnabled = process.env.TALON_TRACE_PERSIST === "1";

function persistSpan(rec: SpanRecord): void {
  if (!persistEnabled) return;
  try {
    ensureDir();
    appendFileSync(currentLogFile(), JSON.stringify(rec) + "\n");
  } catch (err) {
    // Surface to the logger but don't throw — tracing must never break the app.
    logError("trace", "Span persist failed", err);
  }
}

const als = new AsyncLocalStorage<Span>();

function genTraceId(): string {
  return randomBytes(8).toString("hex");
}

function genSpanId(): string {
  return randomBytes(4).toString("hex");
}

function buildSpan(
  name: string,
  parent: Span | undefined,
  attrs: SpanAttributes | undefined,
): Span {
  const traceId = parent?.traceId ?? genTraceId();
  const spanId = genSpanId();
  const startMs = Date.now();
  const events: SpanEvent[] = [];
  const attributes: SpanAttributes = { ...(attrs ?? {}) };
  let status: SpanStatus = "ok";
  let errMsg: string | undefined;
  let ended = false;

  return {
    traceId,
    spanId,
    name,
    setAttribute(key, value) {
      attributes[key] = value;
    },
    setAttributes(a) {
      Object.assign(attributes, a);
    },
    addEvent(evName, evAttrs) {
      events.push({ ts: Date.now(), name: evName, attrs: evAttrs });
    },
    setStatus(s, err) {
      status = s;
      if (s === "error") {
        if (err instanceof Error) errMsg = err.message;
        else if (err !== undefined) errMsg = String(err);
      }
    },
    end() {
      if (ended) {
        // Prevent double-end from emitting a second record.
        return {
          traceId,
          spanId,
          parentSpanId: parent?.spanId,
          name,
          startMs,
          endMs: startMs,
          durationMs: 0,
          status,
          attrs: attributes,
          events,
          err: errMsg,
        };
      }
      ended = true;
      const endMs = Date.now();
      const rec: SpanRecord = {
        traceId,
        spanId,
        parentSpanId: parent?.spanId,
        name,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        status,
        attrs: attributes,
        events,
        err: errMsg,
      };
      pushSpan(rec);
      persistSpan(rec);
      // Emit metrics so histograms show up without every caller opting in.
      recordHistogram(`span.${name}.ms`, rec.durationMs);
      incrementCounter(`span.${name}.${status}`);
      return rec;
    },
  };
}

/** Start a new span. If a parent is active in AsyncLocalStorage, it's linked. */
export function startSpan(name: string, attrs?: SpanAttributes): Span {
  const parent = als.getStore();
  return buildSpan(name, parent, attrs);
}

/**
 * Run `fn` inside a span. The span is made the current context so nested
 * calls to startSpan/withSpan link as children. Errors thrown by `fn` are
 * recorded (status=error) and re-thrown.
 */
export async function withSpan<T>(
  name: string,
  attrs: SpanAttributes | undefined,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const span = startSpan(name, attrs);
  return als.run(span, async () => {
    try {
      const out = await fn(span);
      return out;
    } catch (err) {
      span.setStatus("error", err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** The currently active span (from AsyncLocalStorage), or undefined. */
export function currentSpan(): Span | undefined {
  return als.getStore();
}

/** Snapshot of recent spans (most recent last). */
export function getRecentSpans(limit = 100): SpanRecord[] {
  if (recentSpansSize === 0) return [];
  // Build an ordered snapshot from the ring. Head points at the next slot to
  // write — when the buffer is full, it's also the oldest entry.
  const ordered: SpanRecord[] =
    recentSpansSize < SPAN_RING_SIZE
      ? recentSpans.slice(0, recentSpansSize)
      : [
          ...recentSpans.slice(recentSpansHead),
          ...recentSpans.slice(0, recentSpansHead),
        ];
  return ordered.slice(-limit);
}

/** Clear the in-memory span ring buffer. Intended for tests. */
export function resetSpans(): void {
  for (let i = 0; i < recentSpans.length; i++) {
    recentSpans[i] = undefined as unknown as SpanRecord;
  }
  recentSpansHead = 0;
  recentSpansSize = 0;
}
