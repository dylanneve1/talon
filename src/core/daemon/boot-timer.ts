/**
 * Boot phase timer — one entry per awaited startup phase, reported once
 * the daemon is serving, so "why did it take nine seconds to come up"
 * has an answer in the log instead of a profiler session.
 */

export type BootPhaseSample = { label: string; ms: number };

const phases: BootPhaseSample[] = [];

/** Run one startup phase and remember how long it took. */
export async function bootPhase<T>(
  label: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    phases.push({ label, ms: Date.now() - startedAt });
  }
}

/** `4210ms (plugins 120ms, stores 15ms, frontends 300ms, …)` — total is process uptime. */
export function bootReport(now = Math.round(process.uptime() * 1000)): string {
  const parts = phases.map((phase) => `${phase.label} ${phase.ms}ms`);
  return parts.length ? `${now}ms (${parts.join(", ")})` : `${now}ms`;
}

/**
 * The recorded phases, in the order they completed.
 *
 * `util/` is a leaf (.dependency-cruiser.cjs: util-is-a-leaf), so this
 * module cannot write to the metrics store itself. It hands the samples
 * out instead and `core/daemon/resource-sampler.ts` turns them into
 * `boot.<phase>_ms` histograms.
 */
export function bootPhases(): readonly BootPhaseSample[] {
  return phases;
}

/** Test seam. */
export function resetBootPhases(): void {
  phases.length = 0;
}
