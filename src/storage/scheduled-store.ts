/**
 * Persistent scheduled-message store, backed by the `kv` table
 * (single blob at "scheduled.messages" — the volume is a handful of
 * pending sends, well inside kv's small-state doctrine).
 *
 * Why this exists: `send(..., delay_seconds=N)` used to live only in
 * an in-process setTimeout. The model tells the user "reminder in 30
 * minutes", Talon restarts at minute 20, and the promise silently
 * evaporates — the exact failure the "never promise without a
 * mechanism" rule warns about, baked into the platform. Cron jobs
 * survive restarts; scheduled sends now do too.
 *
 * The store is the source of truth; the per-frontend timer maps are
 * just the armed alarms. Frontends call `restoreScheduled*` variants
 * at action-handler creation: overdue entries fire immediately (late
 * beats never — up to a staleness cap), future entries re-arm.
 */

import { kvGet, kvSet } from "./kv.js";

const KEY = "scheduled.messages";

/** Skip (and drop) entries overdue by more than this — a week-late
 * "dinner in an hour" reminder is noise, not delivery. */
export const MAX_OVERDUE_MS = 24 * 60 * 60 * 1000;

export type ScheduledButtonRow = Array<{
  text: string;
  url?: string;
  callback_data?: string;
}>;

export type ScheduledMessage = {
  id: string;
  /** Which frontend owns delivery ("telegram" | "discord"). */
  frontend: string;
  /** Chat / channel id, in the owning frontend's native shape. */
  chatId: string;
  text: string;
  /** Epoch ms when the message should be sent. */
  fireAt: number;
  createdAt: number;
  /** Telegram: numeric message id to reply to. */
  replyTo?: number;
  /** Telegram: inline keyboard rows. */
  rows?: ScheduledButtonRow[];
};

function readAll(): Record<string, ScheduledMessage> {
  return kvGet<Record<string, ScheduledMessage>>(KEY) ?? {};
}

export function saveScheduled(entry: ScheduledMessage): void {
  const all = readAll();
  all[entry.id] = entry;
  kvSet(KEY, all);
}

export function deleteScheduled(id: string): boolean {
  const all = readAll();
  if (!(id in all)) return false;
  delete all[id];
  kvSet(KEY, all);
  return true;
}

export function getScheduled(id: string): ScheduledMessage | undefined {
  return readAll()[id];
}

/** All pending entries for a frontend, soonest first. */
export function listScheduled(frontend: string): ScheduledMessage[] {
  return Object.values(readAll())
    .filter((e) => e.frontend === frontend)
    .sort((a, b) => a.fireAt - b.fireAt);
}

/** Pending entries for one chat of a frontend, soonest first. */
export function listScheduledForChat(
  frontend: string,
  chatId: string,
): ScheduledMessage[] {
  return listScheduled(frontend).filter((e) => e.chatId === chatId);
}
