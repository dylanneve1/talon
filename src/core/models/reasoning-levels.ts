import type { ReasoningEffortLevel } from "../types.js";

export const REASONING_LEVEL_ORDER: ReasoningEffortLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
];

export const REASONING_LEVEL_LABELS: Record<ReasoningEffortLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Med",
  high: "High",
  max: "Max",
  xhigh: "XHigh",
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
  max: "maximum Claude reasoning budget",
  xhigh: "maximum Codex reasoning budget",
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
