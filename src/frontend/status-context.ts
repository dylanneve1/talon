export interface ContextDisplay {
  known: boolean;
  used: number;
  max: number;
  pct: number;
  bar: string;
  warn: boolean;
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
