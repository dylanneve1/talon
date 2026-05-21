import type { CacheMetricsSupport } from "../core/types.js";

export interface ContextDisplay {
  known: boolean;
  used: number;
  max: number;
  pct: number;
  bar: string;
  warn: boolean;
}

export interface CacheDisplay {
  hitPct: number;
  read: number;
  write: number;
  showsWrite: boolean;
}

/**
 * Resolve what /status should call "Context".
 *
 * `contextTokens` is the only authoritative current-window fill. Some
 * backends don't report it, so older code fell back to `lastPromptTokens`.
 * That fallback is only safe while it fits inside the model window; Codex can
 * report huge cached/cumulative input totals there, which are useful usage
 * stats but not current context fill.
 */
export function buildContextDisplay(input: {
  contextTokens?: number;
  lastPromptTokens?: number;
  contextWindow?: number;
  barLen?: number;
}): ContextDisplay {
  const max =
    typeof input.contextWindow === "number" &&
    Number.isFinite(input.contextWindow) &&
    input.contextWindow > 0
      ? input.contextWindow
      : 0;

  let used =
    typeof input.contextTokens === "number" &&
    Number.isFinite(input.contextTokens) &&
    input.contextTokens > 0
      ? input.contextTokens
      : 0;
  let known = used > 0;

  const fallback =
    typeof input.lastPromptTokens === "number" &&
    Number.isFinite(input.lastPromptTokens) &&
    input.lastPromptTokens > 0
      ? input.lastPromptTokens
      : 0;

  if (!known && fallback > 0 && (max === 0 || fallback <= max)) {
    used = fallback;
    known = true;
  }

  const pct =
    known && max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const barLen = input.barLen ?? 20;
  const filled = Math.round((pct / 100) * barLen);

  return {
    known,
    used,
    max,
    pct,
    bar: "█".repeat(filled) + "░".repeat(barLen - filled),
    warn: known && pct >= 80,
  };
}

/**
 * Resolve whether /status should show cache telemetry.
 *
 * Backends advertise cache support explicitly. If they don't, we hide
 * the whole block instead of printing fake zeroes.
 */
export function buildCacheDisplay(input: {
  cacheMetrics?: CacheMetricsSupport;
  inputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): CacheDisplay | null {
  const mode = input.cacheMetrics ?? "none";
  if (mode === "none") return null;

  const inputTokens =
    typeof input.inputTokens === "number" &&
    Number.isFinite(input.inputTokens) &&
    input.inputTokens > 0
      ? input.inputTokens
      : 0;
  const read =
    typeof input.cacheRead === "number" &&
    Number.isFinite(input.cacheRead) &&
    input.cacheRead > 0
      ? input.cacheRead
      : 0;
  const write =
    mode === "readwrite" &&
    typeof input.cacheWrite === "number" &&
    Number.isFinite(input.cacheWrite) &&
    input.cacheWrite > 0
      ? input.cacheWrite
      : 0;

  // Match the canonical formula in `src/backend/shared/usage.ts:cacheHitPercent`:
  // cache_write is tokens being *written to* cache on this call, not served
  // from it, so it must not dilute the hit ratio. The denominator is
  // `input + read` ("effective input"), regardless of whether the backend
  // also surfaces a write count.
  const denom = inputTokens + read;
  const hitPct = denom > 0 ? Math.round((read / denom) * 100) : 0;

  return {
    hitPct,
    read,
    write,
    showsWrite: mode === "readwrite",
  };
}
