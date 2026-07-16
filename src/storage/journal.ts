/**
 * Event journal — the bus's durable tail in talon.db.
 *
 * The task table and the bus ring are deliberately in-memory: they
 * describe a live process. What IS truthful to persist is history —
 * "what happened" — and every task settlement, turn completion, and
 * future event family already flows through the bus as a typed,
 * content-free record. So the journal is one subscriber (wired at the
 * composition root) appending every published event, and history
 * surfaces (`talon events --history`, `talon ps --all`) read it back —
 * across daemon restarts, with or without a daemon running.
 *
 * Appending must never hurt the daemon: failures are logged once and
 * swallowed, and retention is pruned opportunistically (every
 * PRUNE_EVERY appends) rather than on a timer.
 */

import type { PublishedEvent, TalonEvent } from "../core/bus/index.js";
import { logError } from "../util/log.js";
import * as repo from "./repositories/journal-repo.js";

/** Rows kept after a prune — bounded, but generous for a busy daemon. */
export const JOURNAL_RETENTION = 20_000;

/** Appends between opportunistic prunes. */
const PRUNE_EVERY = 500;

/** One journal record: the event plus its durable cursor and time. */
export interface JournalEntry {
  /** Durable, monotonic cursor — survives restarts (unlike bus ids). */
  readonly seq: number;
  /** Publish time, epoch ms. */
  readonly at: number;
  readonly event: TalonEvent;
}

let appendsSincePrune = 0;
let appendFailureLogged = false;

/**
 * Append one published event. Never throws — the journal is an
 * observer, and a full disk or locked database must not break the bus
 * or the publisher behind it.
 */
export function appendToJournal(event: PublishedEvent): void {
  try {
    repo.append(event.at, event.type, JSON.stringify(event));
    if (++appendsSincePrune >= PRUNE_EVERY) {
      appendsSincePrune = 0;
      repo.prune(JOURNAL_RETENTION);
    }
    appendFailureLogged = false;
  } catch (err) {
    if (!appendFailureLogged) {
      appendFailureLogged = true;
      logError("journal", "Failed to append event to the journal", err);
    }
  }
}

/**
 * Read the journal, newest first. `type` narrows to one event type
 * (indexed). Rows whose payload no longer parses are skipped — a
 * corrupt row must not take down the readable ones around it.
 */
export function readJournal(
  options: { limit?: number; type?: TalonEvent["type"] } = {},
): JournalEntry[] {
  const limit = options.limit ?? 100;
  const rows = options.type
    ? repo.recentByType(options.type, limit)
    : repo.recent(limit);
  const entries: JournalEntry[] = [];
  for (const row of rows) {
    try {
      entries.push({
        seq: row.seq,
        at: row.at,
        event: JSON.parse(row.payload) as TalonEvent,
      });
    } catch {
      // skip the corrupt row
    }
  }
  return entries;
}

/** Total journal rows — surfaced by status/debug tooling. */
export function journalSize(): number {
  return repo.count();
}
