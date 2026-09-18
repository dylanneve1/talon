/**
 * **Turn retrieval** — the per-turn tier of docs/memory-persona-plan.md
 * §3.4, behind `TALON_MEMORY_STORE`.
 *
 * Retrieval has two tiers and the boundary between them is a
 * prompt-cache invariant (plan §3.6):
 *
 *   - **Core view** (`core-view.ts`) — computed once per session build,
 *     lives in `staticText`, frozen for the session.
 *   - **Turn retrieval** (this module) — keyed to the *incoming
 *     message*, resolved once per turn by the Weaver and injected into
 *     the **user turn** by `formatUserPrompt`. It never enters
 *     `prepareSystemPrompt()` and nothing here may ever call
 *     `notifyPromptInputsChanged()` — a per-turn invalidation would
 *     force a full-prompt cache write on every live session, every
 *     turn, which is the single most expensive mistake in the plan.
 *
 * This is the seam #639 deleted, rebuilt without the divergence that
 * justified deleting it. The old `retrievedMemory` field was read by
 * two backends out of six and silently dropped by the rest; now there
 * is exactly ONE consumer — `backend/shared/prompt-format.ts` — that
 * every backend already calls, so a backend cannot forget to inject it
 * without also losing its time tag and `msg_id` framing.
 *
 * **Trust policy (plan §5, #373).** Only `operator` and `agent` rows
 * are ever auto-injected. `user_claim` and `group_chat` rows are
 * reachable only through the explicit `recall` tool: an auto-injected
 * low-trust row is a permanent prompt injection that anyone in a group
 * chat can plant. `reflection` rows are excluded too — the diary is the
 * persona layer and is structurally never a fact source (plan §3.5).
 *
 * **Fail closed.** A broken store must never block chat delivery: any
 * error logs once per process and the turn runs with no injected
 * memory, exactly as if the flag were off.
 */

import {
  formatMemory,
  searchMemories,
  touchMemory,
  type MemoryRow,
  type MemoryTrust,
} from "../../storage/memory.js";
import { logDebug, logWarn } from "../../util/log.js";
import { memoryStoreEnabled } from "./flag.js";

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Hard cap on the injected block, header excluded. Whole rows only —
 * a truncated memory is a misquoted memory, and a half-line is worse
 * than a missing one. Paid on *every* turn (unlike the core view,
 * which is paid once per session and then cached), so it stays small.
 */
export const TURN_MEMORY_MAX_CHARS = 3_000;

/**
 * Candidates pulled from FTS before re-ranking. The trust filter runs
 * *after* this cut, so a query whose twenty best matches are all
 * low-trust injects nothing — which is the conservative direction: an
 * untrusted row must never be promoted into the prompt just because
 * nothing trusted matched.
 */
const CANDIDATE_LIMIT = 20;

/**
 * Trust tiers eligible for automatic injection (plan §5). Everything
 * else stays pull-only, through the explicit `recall` tool.
 */
const AUTO_INJECT_TRUST: ReadonlySet<MemoryTrust> = new Set([
  "operator",
  "agent",
]);

/** `hitCount` at which the affinity term saturates. */
const HIT_SATURATION = 20;

/** Age at which the recency term reaches zero. */
const RECENCY_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Re-ranking weights. bm25 order (as the store returned it) is the
 * strongest signal — it is the only one that knows what was *asked* —
 * and the three store-side signals refine it rather than overturn it:
 * salience is the curator's judgement, `hitCount` is the feedback loop
 * this module itself feeds, and recency breaks ties towards the live
 * world. They sum to 1 so a score reads as a 0..1 fraction.
 */
const W_RELEVANCE = 0.4;
const W_SALIENCE = 0.3;
const W_AFFINITY = 0.2;
const W_RECENCY = 0.1;

// ── Types ───────────────────────────────────────────────────────────────────

/** What one turn's retrieval produced. `undefined` means "inject nothing". */
export type TurnMemory = {
  /** The rendered block, one row per line. Never truncated mid-row. */
  text: string;
  /** How many rows it carries. */
  rows: number;
  /** `text.length` — the per-turn cost, recorded as `turn.memory_chars`. */
  chars: number;
};

/** One turn's retrieval context: the raw inbound message and its chat. */
export type TurnRetrievalInput = {
  chatId: string;
  /** The user's text, as the Weaver received it (no prompt framing yet). */
  text: string;
  isGroup: boolean;
};

// ── Ranking ─────────────────────────────────────────────────────────────────

/** Eligible for auto-injection: trusted tier, and not the diary. */
function injectable(row: MemoryRow): boolean {
  return AUTO_INJECT_TRUST.has(row.trust) && row.kind !== "reflection";
}

/**
 * Blend the store's bm25 order with the row's own standing. `index` is
 * the row's position in the bm25 result, best first.
 */
function score(row: MemoryRow, index: number, total: number, now: number) {
  const relevance = total > 1 ? 1 - index / (total - 1) : 1;
  const affinity = Math.min(
    1,
    Math.log1p(row.hitCount) / Math.log1p(HIT_SATURATION),
  );
  const age = Math.max(0, now - row.lastSeenAt);
  const recency = Math.max(0, 1 - age / RECENCY_HORIZON_MS);
  return (
    W_RELEVANCE * relevance +
    W_SALIENCE * row.salience +
    W_AFFINITY * affinity +
    W_RECENCY * recency
  );
}

/** Trust-filtered candidates, best first. */
function rank(hits: MemoryRow[], now: number): MemoryRow[] {
  const scored = hits
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => injectable(row))
    .map(({ row, index }) => ({
      row,
      score: score(row, index, hits.length, now),
    }));
  scored.sort((a, b) => b.score - a.score || a.row.id - b.row.id);
  return scored.map((s) => s.row);
}

/** Fill the budget with whole rows, in rank order. */
function fill(rows: MemoryRow[]): { lines: string[]; taken: MemoryRow[] } {
  const lines: string[] = [];
  const taken: MemoryRow[] = [];
  let used = 0;
  for (const row of rows) {
    const line = formatMemory(row);
    // +1 for the newline that joins this line to the previous one.
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > TURN_MEMORY_MAX_CHARS) break;
    lines.push(line);
    taken.push(row);
    used += cost;
  }
  return { lines, taken };
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** One warning per process — a broken store must not spam every turn. */
let warned = false;

function failClosed(err: unknown): undefined {
  if (!warned) {
    warned = true;
    logWarn(
      "dispatcher",
      "memory turn retrieval failed (turns run without it): " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  return undefined;
}

/**
 * Retrieve the memory block for one chat turn, or `undefined` when
 * there is nothing to inject (flag off, no match, or any failure).
 *
 * Injected rows are `touch`ed — that is the ranking feedback loop:
 * a row that keeps getting recalled climbs, one that never matches
 * stays where it is.
 */
export function retrieveForTurn(
  input: TurnRetrievalInput,
): TurnMemory | undefined {
  if (!memoryStoreEnabled()) return undefined;
  try {
    // `match: "any"` — the query is a sentence the user wrote as a
    // message, not as a search; AND-ing its every word would match
    // nothing. bm25 over the OR-ed terms does the ranking.
    const hits = searchMemories(input.text, {
      limit: CANDIDATE_LIMIT,
      match: "any",
    });
    if (hits.length === 0) return undefined;
    const { lines, taken } = fill(rank(hits, Date.now()));
    if (taken.length === 0) return undefined;
    for (const row of taken) touchMemory(row.id);
    const text = lines.join("\n");
    logDebug(
      "dispatcher",
      `memory turn retrieval chat=${input.chatId}${input.isGroup ? " (group)" : ""}: ` +
        `${taken.length}/${hits.length} row(s), ${text.length} chars`,
    );
    return { text, rows: taken.length, chars: text.length };
  } catch (err) {
    return failClosed(err);
  }
}
