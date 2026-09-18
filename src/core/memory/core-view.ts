/**
 * The **core view** — the store's contribution to the static system
 * prompt (docs/memory-persona-plan.md §3.4).
 *
 * Retrieval has two tiers, and the boundary between them is a
 * prompt-cache invariant:
 *
 *   - **Core view** (this module) — pinned directives, the relationship
 *     layer and the top durable facts plus fresh `state`, computed
 *     **once per session build** and living in `staticText`. Budgeted,
 *     never truncated mid-section.
 *   - **Turn retrieval** (PR 8) — keyed to the incoming message and
 *     injected into the *user turn*, never into `prepareSystemPrompt()`.
 *
 * Because `prepareSystemPrompt` freezes the assembled prompt per
 * `(chatId, sessionEpoch)`, a fact learned at turn 3 cannot appear in
 * that session's core view. That is the design, not a bug: reaching for
 * `notifyPromptInputsChanged()` to "fix" it would force a full-prompt
 * cache write across every live session on every learned fact (plan
 * §3.6). Nothing here may ever invalidate a snapshot.
 *
 * The store is consulted exactly once per build — one `listMemories`
 * call, ranked and filtered in memory — so the cost of the core view is
 * one query per session, not one per kind and not one per turn.
 */

import { listMemories, type MemoryRow } from "../../storage/memory.js";
import { renderMemoryMarkdown } from "./render.js";

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Char budget for the whole core view (~2 k tokens). Deliberately well
 * under the 12 k file-injection cap: this block is paid for by every
 * session on every frontend, and the rest of the store is a `talon
 * memory list` away.
 */
export const CORE_VIEW_MAX_CHARS = 8_000;

/**
 * A `state` row older than this is stale and left out — a status
 * snapshot nobody has touched in a week is noise in a prompt, and the
 * heartbeat rewrites the live ones far more often than that. Pinning
 * overrides it, which is what pinning is for.
 */
const STATE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Rows pulled from the store before ranking. Generous: the budget, not
 * this number, is what decides how much reaches the prompt.
 */
const CORE_VIEW_ROW_LIMIT = 500;

/**
 * Kinds eligible for the core view, most durable first. `episode` and
 * `reflection` are absent on purpose (plan §3.1): episodes decay fast
 * and are a retrieval-only source, and the diary is the persona layer
 * and never a fact source. Neither enters the core view — not even
 * pinned, since a pin must not promote a kind past the tier boundary.
 */
const CORE_KINDS: readonly MemoryRow["kind"][] = [
  "directive",
  "relationship",
  "fact",
];

// ── Selection ───────────────────────────────────────────────────────────────

/** Salience first, then recency; id breaks the tie so the order is stable. */
function byRank(a: MemoryRow, b: MemoryRow): number {
  return b.salience - a.salience || b.lastSeenAt - a.lastSeenAt || a.id - b.id;
}

function eligible(row: MemoryRow, now: number): boolean {
  if (row.kind === "state")
    return row.pinned || now - row.lastSeenAt <= STATE_FRESH_MS;
  return CORE_KINDS.includes(row.kind);
}

/**
 * Take rows until the budget is spent. A coarse pre-cut on row text
 * only: the render does the exact accounting and cuts on section
 * boundaries, so this exists to keep a 500-row store from being ranked
 * into a document that can hold a fraction of it.
 */
function withinBudget(rows: readonly MemoryRow[], budget: number): MemoryRow[] {
  const taken: MemoryRow[] = [];
  let spent = 0;
  for (const row of rows) {
    if (spent > budget) break;
    spent += row.text.length;
    taken.push(row);
  }
  return taken;
}

/** Options shared by the selection and the render. */
export type CoreViewOptions = {
  /** Char budget for the rendered view. Defaults to `CORE_VIEW_MAX_CHARS`. */
  budget?: number;
  /** Clock for the `state` freshness window (tests pin it). */
  now?: number;
};

/**
 * The ordered rows behind the core view: pinned first (any eligible
 * kind), then directives, then the relationship layer, then facts by
 * salience, then fresh `state`.
 *
 * The render re-sorts with the same ranking (`render.ts` `compareRows`),
 * so this order is what reaches the prompt rather than merely what is
 * handed over — but the selection is asserted here, where the tiers are
 * decided, and not through the rendered bytes.
 */
export function selectCoreRows(opts: CoreViewOptions = {}): MemoryRow[] {
  const now = opts.now ?? Date.now();
  const live = listMemories({ limit: CORE_VIEW_ROW_LIMIT }).filter((row) =>
    eligible(row, now),
  );
  const tiers: MemoryRow[][] = [
    live.filter((row) => row.pinned).sort(byRank),
    ...CORE_KINDS.map((kind) =>
      live.filter((row) => !row.pinned && row.kind === kind).sort(byRank),
    ),
    live.filter((row) => !row.pinned && row.kind === "state").sort(byRank),
  ];
  const seen = new Set<number>();
  const ordered = tiers.flat().filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
  return withinBudget(ordered, opts.budget ?? CORE_VIEW_MAX_CHARS);
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** A rendered core view, with what it cost to carry. */
export type CoreView = {
  text: string;
  /** Rows selected into the view (0 means the store had nothing to say). */
  rows: number;
  /** Rendered size — the number recorded as `prompt.memory_chars`. */
  chars: number;
};

/**
 * Render the core view as a `memory.md`-shaped document, reusing the
 * projection renderer so the store reads identically in the prompt and
 * in the file. Budgeted, not truncated: sections are dropped whole from
 * the bottom of the ranking and the tail is named.
 */
export function renderCoreView(opts: CoreViewOptions = {}): CoreView {
  const budget = opts.budget ?? CORE_VIEW_MAX_CHARS;
  const rows = selectCoreRows({ ...opts, budget });
  const text = renderMemoryMarkdown({ rows, budget });
  return { text, rows: rows.length, chars: text.length };
}
