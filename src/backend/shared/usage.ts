/**
 * Token usage accounting helpers shared across backends.
 *
 * Every backend ends up doing the same arithmetic: input + cache_read,
 * cache_hit percentage, sum-of-iterations for context-fill estimation.
 * Pull the logic out so it's tested once and used everywhere — and so
 * any rounding/edge-case fix lands in one place.
 */

// ── Public API ──────────────────────────────────────────────────────────────

/** A unified token-usage snapshot collected from a single backend turn. */
export type TokenUsageSnapshot = {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
};

/**
 * Compute the cache-hit ratio as a percentage of effective input.
 *
 * Effective input = `inputTokens + cacheRead`. Returns 0 when there's
 * no input at all (avoids NaN/Inf). Result is integer 0–100.
 */
export function cacheHitPercent(usage: TokenUsageSnapshot): number {
  const denom = usage.inputTokens + usage.cacheRead;
  if (denom <= 0) return 0;
  return Math.round((usage.cacheRead / denom) * 100);
}

/** A compact one-line summary suitable for agent logs. */
export function summarizeUsage(
  usage: TokenUsageSnapshot,
  extras?: {
    durationMs?: number;
    toolCalls?: number;
    suffix?: string;
  },
): string {
  const parts: string[] = [];
  if (extras?.durationMs !== undefined) parts.push(`${extras.durationMs}ms`);
  parts.push(`in=${usage.inputTokens}`);
  parts.push(`out=${usage.outputTokens}`);
  parts.push(`cache=${cacheHitPercent(usage)}%`);
  if (extras?.toolCalls && extras.toolCalls > 0) {
    parts.push(`tools=${extras.toolCalls}`);
  }
  if (extras?.suffix) parts.push(extras.suffix);
  return parts.join(" ");
}
