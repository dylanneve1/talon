/**
 * Prompt-cache rollups — the per-turn verdict, the tool fingerprint and the
 * SDK's compaction boundaries, folded into counters an operator can read.
 *
 * `cache-telemetry.ts` next door decides WHAT a turn did (verdict,
 * fingerprint, lookback risk) and is pure apart from its own per-chat maps.
 * This module is the side-effecting half: it writes to the metrics store and
 * logs, so the telemetry stays testable without a store.
 *
 * Why these numbers exist (docs/cache-economics.md, PR A): every decision in
 * PR B ("one prefix per frontend") and PR C ("compact when the cache has gone
 * cold") needs a before/after figure, and nothing here changes a prompt byte
 * or a turn's behaviour — measurement only.
 *
 *   - `cache.first_request.{hit,miss,none}` — did the previous turn's prefix
 *     survive? The turn's first request is the only one that can say, and it
 *     is the number that tracks cost.
 *   - `cache.first_request.{read,write}_tokens` — how big the prefix is, so a
 *     miss can be priced.
 *   - `cache.session_start.{hit,miss,none}` — the same verdict restricted to a
 *     chat's FIRST turn. A hit there means another chat had already warmed an
 *     identical prefix: the cross-chat sharing signal PR B is aiming at.
 *   - `cache.tool_fingerprint.changed` — tools render before the system
 *     prompt, so a change invalidates everything after it.
 *   - `session.compacted.{manual,auto}` + `session.compact.{pre,post}_tokens`
 *     — how often the SDK compacts and how much it reclaims, the baseline
 *     PR C's idle-compaction policy is measured against.
 */

import { log } from "../../util/log.js";
import {
  incrementCounter,
  noteCacheVerdict,
  recordHistogram,
} from "../../storage/metrics.js";
import {
  crossTurnVerdict,
  fingerprintHash,
  hasToolFingerprint,
  noteToolFingerprint,
  type CrossTurnVerdict,
  type TurnCacheStats,
} from "./cache-telemetry.js";

/**
 * Roll one finished turn's cache behaviour up into the metrics store and
 * remember the verdict for `/status`.
 *
 * `turnsIncludingThis` is the chat's turn count with this turn already
 * counted, so 1 means the turn was the session's first — the only turn whose
 * verdict says anything about cross-chat prefix sharing.
 */
export function rollUpTurnCache(
  chatId: string,
  stats: TurnCacheStats,
  turnsIncludingThis: number,
): CrossTurnVerdict {
  const verdict = crossTurnVerdict(stats);
  incrementCounter(`cache.first_request.${verdict}`);
  // Recorded on every turn, zeros included: the average is then "tokens per
  // turn", which is what a miss costs, rather than an average over the
  // turns that happened to be interesting.
  recordHistogram("cache.first_request.read_tokens", stats.firstRead);
  recordHistogram("cache.first_request.write_tokens", stats.firstWrite);
  if (turnsIncludingThis <= 1) {
    incrementCounter(`cache.session_start.${verdict}`);
  }
  noteCacheVerdict(chatId, verdict);
  return verdict;
}

/**
 * Record a chat's tool set: one info line the first time a chat is seen (so
 * two chats on the same frontend can be compared by eye — identical hash +
 * identical static prompt ⇒ shared cache), and a counter whenever it changes
 * mid-process. `noteToolFingerprint` still owns the warning it already logs
 * for a mid-session change.
 */
export function reportToolFingerprint(
  chatId: string,
  fingerprint: readonly string[],
): void {
  const seen = hasToolFingerprint(chatId);
  const changed = noteToolFingerprint(chatId, fingerprint);
  if (!seen) {
    log(
      "agent",
      `[${chatId}] tool fingerprint ${fingerprintHash(fingerprint)} ` +
        `(${fingerprint.length} tools)`,
    );
  }
  if (changed) incrementCounter("cache.tool_fingerprint.changed");
}

/** The SDK's compaction metadata, narrowed to the fields that are measured. */
export type CompactBoundary = {
  trigger: "manual" | "auto";
  pre_tokens: number;
  post_tokens?: number;
};

/**
 * Record a compaction boundary the SDK reported mid-stream. Purely
 * observational — the turn carries on exactly as it did before, this just
 * stops the event being dropped on the floor.
 */
export function recordCompactBoundary(
  chatId: string,
  meta: CompactBoundary,
): void {
  const trigger = meta.trigger === "manual" ? "manual" : "auto";
  incrementCounter(`session.compacted.${trigger}`);
  const pre = Number.isFinite(meta.pre_tokens) ? meta.pre_tokens : 0;
  const post =
    typeof meta.post_tokens === "number" && Number.isFinite(meta.post_tokens)
      ? meta.post_tokens
      : undefined;
  recordHistogram("session.compact.pre_tokens", pre);
  if (post !== undefined) recordHistogram("session.compact.post_tokens", post);
  log(
    "agent",
    `[${chatId}] context compacted (${trigger}): ${pre} tokens` +
      (post !== undefined ? ` -> ${post}` : "") +
      ` — the prefix after the boundary is new, so the next turn re-writes it`,
  );
}
