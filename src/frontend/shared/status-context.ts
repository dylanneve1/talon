import type { CacheMetricsSupport } from "../../core/types.js";

// ── /context breakdown ────────────────────────────────────────────────────────

/**
 * Rough token estimate — ~4 chars/token, the house heuristic used everywhere
 * (soul/projector, cache-telemetry). No real tokenizer is wired, so every
 * measured figure in the breakdown below is an estimate at this fidelity.
 */
export function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type ContextSegmentKey = "system" | "tools" | "conversation";

interface ContextSegment {
  key: ContextSegmentKey;
  label: string;
  tokens: number;
  /** Share of the window (0–100) when the window is known, else share of used. */
  pct: number;
}

export interface ContextBreakdown {
  /** True once there is anything to show (a system prompt or a reported fill). */
  known: boolean;
  /** True when the window size is known — only then can free space be shown. */
  windowKnown: boolean;
  used: number;
  max: number;
  usedPct: number;
  free: number;
  freePct: number;
  /** Fixed → variable order: System, Tools, Conversation. */
  segments: ContextSegment[];
  warn: boolean;
}

function posInt(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.round(n)
    : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Decompose the context window into System / Tools / Conversation + free.
 *
 * The honesty this has to preserve: the backend reports exactly one
 * authoritative number, `contextTokens` (the real last-turn fill). Nothing
 * reports a per-category split, so:
 *
 *   - **System** is measured from the actual (frozen) system prompt — accurate,
 *     and the part a user can act on.
 *   - **Conversation** is estimated from stored history. It can overshoot what
 *     is really in-window after compaction; when it does, it is clamped to fit.
 *   - **Tools** is the residual: `used − system − conversation`. Tool schemas
 *     (invisible to us — they live inside the SDK) dominate it, but it also
 *     absorbs message-formatting overhead and estimation slack. Labelled as the
 *     remainder, not claimed as exact.
 *
 * When the backend reports no fill, tools cannot be derived, so only the two
 * measured/estimated parts are shown and the window's free space (if known) is
 * whatever is left of it.
 */
export function buildContextBreakdown(input: {
  contextTokens?: number;
  contextWindow?: number;
  systemTokens: number;
  conversationTokens: number;
}): ContextBreakdown {
  const max = posInt(input.contextWindow);
  const system = Math.max(0, Math.round(input.systemTokens));
  let conversation = Math.max(0, Math.round(input.conversationTokens));
  const fill = posInt(input.contextTokens);

  const segments: ContextSegment[] = [];
  let used: number;

  if (fill > 0) {
    used = fill;
    // System is sent in full every turn; if our estimate exceeds the real fill
    // that is estimation slack, not reality — clamp so parts never exceed used.
    const sys = Math.min(system, used);
    let tools = used - sys - conversation;
    if (tools < 0) {
      // Conversation overshot the real fill (compaction dropped in-window
      // messages) — give the remainder back to conversation, zero the residual.
      conversation = Math.max(0, used - sys);
      tools = 0;
    }
    segments.push({ key: "system", label: "System", tokens: sys, pct: 0 });
    segments.push({ key: "tools", label: "Tools", tokens: tools, pct: 0 });
    segments.push({
      key: "conversation",
      label: "Conversation",
      tokens: conversation,
      pct: 0,
    });
  } else {
    // No authoritative fill — show what we can measure; tools isn't derivable.
    used = system + conversation;
    segments.push({ key: "system", label: "System", tokens: system, pct: 0 });
    segments.push({
      key: "conversation",
      label: "Conversation",
      tokens: conversation,
      pct: 0,
    });
  }

  const windowKnown = max > 0;
  const free = windowKnown ? Math.max(0, max - used) : 0;
  const denom = windowKnown ? max : used;
  for (const s of segments) {
    s.pct = denom > 0 ? round1((s.tokens / denom) * 100) : 0;
  }

  return {
    known: used > 0,
    windowKnown,
    used,
    max,
    usedPct: windowKnown ? Math.min(100, round1((used / max) * 100)) : 0,
    free,
    freePct: windowKnown ? round1((free / max) * 100) : 0,
    segments,
    warn: windowKnown && used / max >= 0.8,
  };
}

/**
 * Distribute `width` integer cells across `weights` proportionally, by the
 * largest-remainder method — the cells sum to exactly `width` and no positive
 * weight is systematically rounded to nothing before its peers. Zero weights
 * get zero cells. Used to lay out the segmented bar so its coloured runs sum to
 * the bar width regardless of rounding.
 */
export function apportionCells(
  weights: readonly number[],
  width: number,
): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || width <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (Math.max(0, w) / total) * width);
  const cells = exact.map((x) => Math.floor(x));
  let remaining = width - cells.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of byRemainder) {
    if (remaining <= 0) break;
    if (weights[i]! > 0) {
      cells[i]!++;
      remaining--;
    }
  }
  return cells;
}

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
