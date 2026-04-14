// src/util/metrics.ts — lightweight in-process metrics

const counters = new Map<string, number>();
const MAX_METRIC_KEYS = 500; // cap to prevent unbounded growth from high-cardinality names

// Ring buffer for histograms — O(1) insert, avoids splice overhead
interface RingBuffer {
  data: number[];
  head: number; // next write position
  size: number; // current number of valid entries (≤ capacity)
}

const histograms = new Map<string, RingBuffer>();
const MAX_HISTOGRAM_SIZE = 1000;

function createRingBuffer(capacity: number): RingBuffer {
  return { data: new Array<number>(capacity), head: 0, size: 0 };
}

function ringPush(buf: RingBuffer, value: number): void {
  buf.data[buf.head] = value;
  buf.head = (buf.head + 1) % buf.data.length;
  if (buf.size < buf.data.length) buf.size++;
}

function ringValues(buf: RingBuffer): number[] {
  if (buf.size < buf.data.length) return buf.data.slice(0, buf.size);
  // Full ring — read from head (oldest) wrapping around
  return [...buf.data.slice(buf.head), ...buf.data.slice(0, buf.head)];
}

export function incrementCounter(name: string, amount = 1): void {
  // Only allow new keys up to the cap — existing keys always pass
  if (!counters.has(name) && counters.size >= MAX_METRIC_KEYS) return;
  counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function recordHistogram(name: string, value: number): void {
  if (!Number.isFinite(value)) return; // drop NaN/Infinity/invalid samples
  let buf = histograms.get(name);
  if (!buf) {
    if (histograms.size >= MAX_METRIC_KEYS) return; // cap key count
    buf = createRingBuffer(MAX_HISTOGRAM_SIZE);
    histograms.set(name, buf);
  }
  ringPush(buf, value);
}

export function getMetrics(): {
  counters: Record<string, number>;
  histograms: Record<
    string,
    { count: number; p50: number; p95: number; p99: number; avg: number }
  >;
} {
  const result: ReturnType<typeof getMetrics> = {
    counters: {},
    histograms: {},
  };
  for (const [k, v] of counters) result.counters[k] = v;
  for (const [k, buf] of histograms) {
    if (buf.size === 0) continue;
    const values = ringValues(buf);
    const sorted = [...values].sort((a, b) => a - b);
    const len = sorted.length;
    result.histograms[k] = {
      count: len,
      p50: sorted[Math.floor(len * 0.5)],
      p95: sorted[Math.floor(len * 0.95)],
      p99: sorted[Math.floor(len * 0.99)],
      avg: Math.round(values.reduce((a, b) => a + b, 0) / len),
    };
  }
  return result;
}

export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
}
