/**
 * Discord action-handler types.
 *
 * Each domain module exports a `DiscordActionHandlers` map keyed by action
 * name. Handlers receive the request body, the numeric chat id, and a shared
 * `DiscordActionContext` carrying the client, gateway, per-handler scheduled
 * timers, and the channel pre-resolved by the dispatcher.
 *
 * `channel` is non-null for every action except `cancel_scheduled` and
 * `list_scheduled` (store-only actions that don't need a resolved channel) —
 * the dispatcher guarantees this, so handlers can safely use `ctx.channel!`.
 */

import type { Client, TextBasedChannel } from "discord.js";
import type { Gateway } from "../../../core/engine/gateway.js";
import type { ActionResult } from "../../../core/types.js";

export interface DiscordActionContext {
  client: Client;
  gateway: Gateway;
  /** Active scheduled-message timers, keyed by schedule id (for cancellation). */
  scheduledMessages: Map<string, ReturnType<typeof setTimeout>>;
  /** Channel resolved from the chat id; null only for cancel_scheduled / list_scheduled. */
  channel: TextBasedChannel | null;
}

export type DiscordActionHandler = (
  body: Record<string, unknown>,
  chatId: number,
  ctx: DiscordActionContext,
) => Promise<ActionResult | null> | ActionResult | null;

export type DiscordActionHandlers = Record<string, DiscordActionHandler>;
