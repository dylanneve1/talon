/**
 * Shared-action handler types.
 *
 * Each domain module (history, cron, triggers, …) exports a
 * `SharedActionHandlers` map keyed by action name. `index.ts` merges them
 * into one registry that `handleSharedAction` dispatches through.
 */

import type { ActionResult } from "../../types.js";
import type { Backend } from "../../agent-runtime/capabilities.js";

export type SharedActionHandler = (
  body: Record<string, unknown>,
  chatId: number,
  backend?: Backend | null,
) => Promise<ActionResult> | ActionResult;

export type SharedActionHandlers = Record<string, SharedActionHandler>;
