import type { ReasoningEffortLevel } from "../types.js";

/**
 * Ascending ladder, weakest reasoning first. This is the ONLY ordering in
 * the codebase: `normalizeReasoningLevels` re-sorts a model's advertised
 * levels through it, so every effort picker (Telegram, Discord, native)
 * renders in this sequence.
 *
 * `xhigh` (Codex's ceiling) sits below `max` (Claude's ceiling) so the row
 * reads low → medium → high → xhigh → max. A single model advertises one
 * ceiling or the other, never both, so their relative position only ever
 * matters for how the ladder reads.
 */
export const REASONING_LEVEL_ORDER: ReasoningEffortLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const REASONING_LEVEL_LABELS: Record<ReasoningEffortLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export const REASONING_LEVEL_DESCRIPTIONS: Record<
  ReasoningEffortLevel | "adaptive",
  string
> = {
  off: "disable model reasoning when supported",
  minimal: "smallest reasoning budget",
  low: "short reasoning pass",
  medium: "balanced reasoning",
  high: "deeper reasoning, slower",
  xhigh: "maximum Codex reasoning budget",
  max: "maximum Claude reasoning budget",
  adaptive: "use the model/backend default",
};

const KNOWN_LEVELS = new Set<ReasoningEffortLevel>(REASONING_LEVEL_ORDER);

export function normalizeReasoningLevels(
  levels: readonly string[] | undefined,
): ReasoningEffortLevel[] {
  if (!levels?.length) return [];
  const seen = new Set<ReasoningEffortLevel>();
  for (const raw of levels) {
    const level = raw.trim().toLowerCase() as ReasoningEffortLevel;
    if (!KNOWN_LEVELS.has(level) || seen.has(level)) continue;
    seen.add(level);
  }
  return REASONING_LEVEL_ORDER.filter((level) => seen.has(level));
}

export function supportsReasoningLevel(
  level: string,
  supported: readonly ReasoningEffortLevel[],
): level is ReasoningEffortLevel {
  return supported.includes(level as ReasoningEffortLevel);
}
