/**
 * The daemon's accounting of its own resources — boot cost and resident
 * memory. Measurement only: nothing here changes a prompt byte or a
 * turn's behaviour.
 *
 * Why these numbers exist (docs/ts-migration-plan.md, Phase 0 — Measure):
 * the migration plan's entry gate is "numbers in hand", and its kill
 * criterion is stated in terms of the control plane's share of a turn plus
 * "RSS is acceptable". Neither can be argued without a baseline, and the
 * metrics store had latency and tokens but nothing about the process
 * itself.
 *
 *   - `boot.total_ms` — process start → frontends listening. The figure
 *     `Ready in …` already logs, kept as a distribution so successive
 *     restarts can be compared instead of grepped.
 *   - `boot.<phase>_ms` — each awaited startup phase (`util/boot-timer.ts`
 *     records them), so a slow boot names its own culprit.
 *   - `boot.rss_mb` / `boot.heap_mb` — what the process costs the moment
 *     it is serving, before any turn has run. The floor an alternative
 *     runtime or language would have to beat.
 *   - `rss.mb`, `heap_used.mb`, `external.mb`, `handles.count` — the same
 *     picture sampled every minute for the process lifetime, which is what
 *     answers "idle RSS" and "does it creep?" (the Phase 1 soak log asks
 *     exactly this and is currently filled in by hand).
 *
 * Sampling must never throw: this runs on a timer inside a live daemon,
 * and a metric that can take the process down is worse than no metric.
 */

import { bootPhases } from "../../util/boot-timer.js";
import { recordHistogram } from "../../storage/metrics.js";

/** One minute. Idle RSS moves slowly; a tighter loop would only add noise. */
const SAMPLE_INTERVAL_MS = 60_000;

const BYTES_PER_MB = 1024 * 1024;

let timer: ReturnType<typeof setInterval> | null = null;

function mb(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MB);
}

/**
 * `frontends start` → `boot.frontends_start_ms`. Phase labels are prose
 * ("backend + dispatcher"), metric names are not.
 */
function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unnamed"
  );
}

/** How many active handles the runtime reports, when it can report it. */
function activeResourceCount(): number | undefined {
  // Node 18.11+ / Bun. Absent on older runtimes, and there is no cheap
  // supported substitute — the metric is simply skipped there.
  const read = (process as { getActiveResourcesInfo?: () => readonly string[] })
    .getActiveResourcesInfo;
  if (typeof read !== "function") return undefined;
  const info = read.call(process);
  return Array.isArray(info) ? info.length : undefined;
}

/** Record one resident-memory sample. Safe to call at any time. */
function sampleResources(): void {
  try {
    const mem = process.memoryUsage();
    recordHistogram("rss.mb", mb(mem.rss));
    recordHistogram("heap_used.mb", mb(mem.heapUsed));
    recordHistogram("external.mb", mb(mem.external));
    const handles = activeResourceCount();
    if (handles !== undefined) recordHistogram("handles.count", handles);
  } catch {
    // A failed sample is a missing data point, never a failed daemon.
  }
}

/**
 * Fold the boot into the metrics store: the total, every phase the boot
 * timer recorded, and the memory the process holds now that it is serving.
 *
 * `totalMs` defaults to process uptime — the same figure `bootReport()`
 * prints, so the log line and the histogram cannot disagree.
 */
export function recordBootMetrics(
  totalMs = Math.round(process.uptime() * 1000),
): void {
  try {
    recordHistogram("boot.total_ms", totalMs);
    for (const phase of bootPhases()) {
      recordHistogram(`boot.${slug(phase.label)}_ms`, phase.ms);
    }
    const mem = process.memoryUsage();
    recordHistogram("boot.rss_mb", mb(mem.rss));
    recordHistogram("boot.heap_mb", mb(mem.heapUsed));
  } catch {
    // As above: measurement never breaks the boot it is measuring.
  }
}

/**
 * Start the idle sampler. Unref'd, so it never holds the event loop open
 * and never keeps a daemon alive that is otherwise done. Idempotent —
 * a second call is a no-op rather than a second timer.
 */
export function startResourceSampler(): void {
  if (timer) return;
  timer = setInterval(sampleResources, SAMPLE_INTERVAL_MS);
  timer.unref();
}

/** Stop the idle sampler (shutdown, and the test seam). */
export function stopResourceSampler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
