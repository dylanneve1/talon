// src/util/metrics.ts — lightweight in-process metrics

const counters = new Map<string, number>();
const histograms = new Map<string, number[]>();
const MAX_HISTOGRAM_SIZE = 1000;

export function incrementCounter(name: string, amount = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function recordHistogram(name: string, value: number): void {
  if (!Number.isFinite(value)) return; // drop NaN/Infinity/invalid samples
  let values = histograms.get(name);
  if (!values) {
    values = [];
    histograms.set(name, values);
  }
  values.push(value);
  if (values.length > MAX_HISTOGRAM_SIZE) {
    values.splice(0, values.length - MAX_HISTOGRAM_SIZE);
  }
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
  for (const [k, values] of histograms) {
    if (values.length === 0) continue;
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
