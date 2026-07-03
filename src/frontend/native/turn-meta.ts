/**
 * Turn-meta sidecar — thin native-frontend façade over the shared
 * storage/turn-meta store. It owns the TurnMeta *shape* (tool calls,
 * duration, token usage — the companion app's tool timeline and stats
 * footer); the storage layer treats each record as opaque JSON.
 *
 * The data used to live in a debounced JSON file under the data dir;
 * it now rides the `turn_meta` SQLite table shared by every frontend.
 * SQLite commits on every write, so the old flush timer is gone.
 */

import {
  recordTurnMeta as storeRecordTurnMeta,
  getTurnMeta as storeGetTurnMeta,
  clearTurnMeta as storeClearTurnMeta,
} from "../../storage/turn-meta.js";
import type { ClientToolCall } from "./protocol.js";

export type TurnMeta = {
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  tools?: ClientToolCall[];
};

/** Record (or extend) the meta for one assistant message. */
export function recordTurnMeta(
  chatId: string,
  msgId: string,
  meta: TurnMeta,
): void {
  storeRecordTurnMeta(chatId, msgId, meta);
}

/** Look up the meta for one message, or null. */
export function getTurnMeta(chatId: string, msgId: string): TurnMeta | null {
  return storeGetTurnMeta<TurnMeta>(chatId, msgId);
}

/** Forget a chat entirely (chat deleted / history cleared). */
export function clearTurnMeta(chatId: string): void {
  storeClearTurnMeta(chatId);
}
