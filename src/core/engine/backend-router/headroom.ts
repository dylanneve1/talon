/**
 * Headroom — "how much of this backend is left?", answered the same way for
 * every backend regardless of what it can tell us about itself.
 *
 * Two sources, in precedence order:
 *
 *   - `plan`   — the backend's own subscription windows
 *                (`UsageTelemetry.getPlanUsage`). Authoritative: it is the
 *                provider's own count, including spend from outside Talon.
 *   - `ledger` — Talon's local rolling token count (see `ledger.ts`) against
 *                the operator's soft budget (`config.backendBudgets`). The
 *                fallback for backends with no account API.
 *
 * A backend with neither reports `source: "none"` and headroom 1. That is a
 * deliberate "no evidence of pressure", not a claim of capacity — the
 * router's comparator ranks it *below* any backend with real telemetry at
 * the same headroom, so an unmeasured backend never outranks a measured one
 * it is tied with.
 *
 * Reads are cached for 60s per backend: `/usage`, the router and the
 * `plan_usage` tool all ask, and a plan lookup can be a subprocess spawn. A
 * failed refresh keeps the last good value and flags it `stale` rather than
 * pretending the backend emptied.
 */

import type { PlanUsage } from "../../agent-runtime/capabilities.js";
import type { TalonConfig } from "../../config/index.js";
import {
  getPooledBackend,
  listAvailableBackends,
} from "../backend-controller/index.js";
import {
  LEDGER_RETENTION_MS,
  LEDGER_SHORT_WINDOW_MS,
  ledgerUsage,
} from "./ledger.js";

/** How long a headroom reading is reused before the source is asked again. */
export const HEADROOM_CACHE_MS = 60_000;

/** Where a headroom figure came from. Also its ranking priority. */
export type HeadroomSource = "plan" | "ledger" | "none";

/** The window that is closest to its limit — what the ceiling is judged on. */
export interface LimitingWindow {
  readonly label: string;
  /** 0-100. */
  readonly percent: number;
  readonly resetsAt?: string;
}

export interface BackendHeadroom {
  readonly id: string;
  readonly label: string;
  /** 0..1 — 1 is empty, 0 is at the limit. */
  readonly headroom: number;
  readonly limiting?: LimitingWindow;
  readonly source: HeadroomSource;
  /** Epoch ms of the underlying read. */
  readonly fetchedAt: number;
  /** True when the last refresh failed and this is the previous value. */
  readonly stale?: boolean;
}

interface CacheEntry {
  value: BackendHeadroom;
  /** Epoch ms the value was computed (not the same as a stale `fetchedAt`). */
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

/** headroom = 1 − (tightest window) / 100. */
function headroomFor(percent: number): number {
  return Math.max(0, Math.min(1, 1 - clampPercent(percent) / 100));
}

/**
 * The tightest of a plan's windows. `undefined` when the plan reports none,
 * which is how a backend that answers but has nothing to say is told apart
 * from one that never answered.
 */
export function limitingWindowOf(
  usage: PlanUsage | undefined,
): LimitingWindow | undefined {
  if (!usage || usage.windows.length === 0) return undefined;
  let worst = usage.windows[0] as NonNullable<(typeof usage.windows)[0]>;
  for (const window of usage.windows) {
    if (window.percent > worst.percent) worst = window;
  }
  return {
    label: worst.label,
    percent: clampPercent(worst.percent),
    ...(worst.resetsAt ? { resetsAt: worst.resetsAt } : {}),
  };
}

/** Headroom from a `PlanUsage`, or `undefined` when it carries no windows. */
export function headroomFromPlan(
  id: string,
  label: string,
  usage: PlanUsage | undefined,
): BackendHeadroom | undefined {
  const limiting = limitingWindowOf(usage);
  if (!limiting || !usage) return undefined;
  return {
    id,
    label,
    headroom: headroomFor(limiting.percent),
    limiting,
    source: "plan",
    fetchedAt: usage.fetchedAt,
  };
}

/** The soft budget an operator declared for a backend, if any. */
function budgetFor(
  config: TalonConfig | undefined,
  id: string,
): { tokensPer5h?: number; tokensPerDay?: number } | undefined {
  const budget = config?.backendBudgets?.[id];
  if (!budget) return undefined;
  if (budget.tokensPer5h === undefined && budget.tokensPerDay === undefined) {
    return undefined;
  }
  return budget;
}

/** Whether the operator gave this backend a local budget to measure against. */
export function hasBudget(
  config: TalonConfig | undefined,
  id: string,
): boolean {
  return budgetFor(config, id) !== undefined;
}

/**
 * Headroom from the local ledger. The tighter of the two configured windows
 * wins, so a backend that is fine on the day but has just burned its 5h
 * allowance still reads as full.
 */
export function headroomFromLedger(
  id: string,
  label: string,
  config: TalonConfig | undefined,
  now = Date.now(),
): BackendHeadroom | undefined {
  const budget = budgetFor(config, id);
  if (!budget) return undefined;
  const used = ledgerUsage(id, now);
  const windows: LimitingWindow[] = [];
  if (budget.tokensPer5h !== undefined) {
    windows.push({
      label: "5h (local budget)",
      percent: clampPercent((used.tokens5h / budget.tokensPer5h) * 100),
    });
  }
  if (budget.tokensPerDay !== undefined) {
    windows.push({
      label: "24h (local budget)",
      percent: clampPercent((used.tokensDay / budget.tokensPerDay) * 100),
    });
  }
  let worst = windows[0] as LimitingWindow;
  for (const window of windows)
    if (window.percent > worst.percent) worst = window;
  return {
    id,
    label,
    headroom: headroomFor(worst.percent),
    limiting: worst,
    source: "ledger",
    fetchedAt: now,
  };
}

/** The "nothing to measure" reading. Headroom 1, but lowest ranking source. */
function unknownHeadroom(
  id: string,
  label: string,
  now: number,
): BackendHeadroom {
  return { id, label, headroom: 1, source: "none", fetchedAt: now };
}

/** Ask a pooled backend for its plan windows; never throws. */
async function readPlanUsage(id: string): Promise<PlanUsage | undefined> {
  const backend = getPooledBackend(id);
  const read = backend?.usage?.getPlanUsage;
  if (!read || !backend?.usage) return undefined;
  return read.call(backend.usage);
}

/**
 * Headroom for one backend, cached for {@link HEADROOM_CACHE_MS}.
 *
 * `force` skips the cache — the `plan_usage` tool asks for a fresh read
 * because the operator is looking at the number right now.
 */
export async function getBackendHeadroom(
  id: string,
  label: string,
  config: TalonConfig | undefined,
  options?: { force?: boolean; now?: number },
): Promise<BackendHeadroom> {
  const now = options?.now ?? Date.now();
  const cached = cache.get(id);
  if (!options?.force && cached && now - cached.cachedAt < HEADROOM_CACHE_MS) {
    return cached.value;
  }

  let value: BackendHeadroom;
  try {
    const plan = headroomFromPlan(id, label, await readPlanUsage(id));
    value =
      plan ??
      headroomFromLedger(id, label, config, now) ??
      unknownHeadroom(id, label, now);
  } catch {
    // The source is unreachable this minute. Keeping the last good reading
    // is the conservative answer: forgetting it would read as "empty" and
    // send the next background run straight at a backend near its ceiling.
    value = cached
      ? { ...cached.value, stale: true }
      : unknownHeadroom(id, label, now);
  }
  cache.set(id, { value, cachedAt: now });
  return value;
}

/** Headroom for every backend the config exposes, in config order. */
export async function collectBackendHeadroom(
  config: TalonConfig | undefined,
  options?: { force?: boolean; now?: number },
): Promise<BackendHeadroom[]> {
  const backends = listAvailableBackends(config);
  return Promise.all(
    backends.map(({ id, label }) =>
      getBackendHeadroom(id, label, config, options),
    ),
  );
}

/** One-line rendering shared by `/usage`, `plan_usage` and the router log. */
export function formatHeadroom(entry: BackendHeadroom): string {
  const pct = `${Math.round(entry.headroom * 100)}%`;
  const detail =
    entry.source === "none"
      ? "no usage signal"
      : `${entry.limiting?.label ?? "window"} ${Math.round(entry.limiting?.percent ?? 0)}% used`;
  const tag = entry.source === "ledger" ? " (local budget)" : "";
  const stale = entry.stale ? " (stale)" : "";
  return `${pct} — ${detail}${tag}${stale}`;
}

/** Test seam — drop every cached reading. */
export function resetHeadroomCacheForTest(): void {
  cache.clear();
}

/** Window widths the ledger measures, re-exported for renderers. */
export const HEADROOM_WINDOWS = {
  shortMs: LEDGER_SHORT_WINDOW_MS,
  dayMs: LEDGER_RETENTION_MS,
} as const;
