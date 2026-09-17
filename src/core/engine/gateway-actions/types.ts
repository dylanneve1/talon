/**
 * Shared-action handler types.
 *
 * Each domain module (history, cron, triggers, …) exports a
 * `SharedActionHandlers` map keyed by action name. `index.ts` merges them
 * into one registry that `handleSharedAction` dispatches through.
 */

import type { ActionResult } from "../../types.js";
import type { Backend } from "../../agent-runtime/capabilities.js";

/**
 * `chatId` is the frontend's numeric id — the only identity the HTTP bridge
 * carries. `chatKey` is the chat's canonical string id (the dispatcher's
 * `chatId`, which every store is keyed on): for Telegram it is just
 * `String(chatId)`, for every other frontend it is the real id the numeric
 * one was derived from (`d_…`, `wa_…`, `discord_…`). Handlers that persist,
 * look up, or route by chat must use `chatKey`, never `String(chatId)` —
 * a `d_…` chat's jobs stored under its numeric id fire into Telegram.
 */
type SharedActionHandler = (
  body: Record<string, unknown>,
  chatId: number,
  backend: Backend | null | undefined,
  chatKey: string,
) => Promise<ActionResult> | ActionResult;

export type SharedActionHandlers = Record<string, SharedActionHandler>;
