/**
 * WhatsApp action-handler types.
 *
 * Each domain module exports a `WhatsAppActionHandlers` map keyed by
 * action name. Handlers receive the request body, the numeric chat id,
 * and a shared context carrying the live socket, the gateway, the chat
 * resolved from the id, and the per-handler scheduled-send timers.
 *
 * `chat` is non-null for every action the dispatcher routes here except
 * the store-only scheduling ones, so handlers can use `ctx.chat!`.
 */

import type { WASocket } from "baileys";
import type { Gateway } from "../../../core/engine/gateway.js";
import type { ActionResult } from "../../../core/types.js";
import type { WhatsAppChatInfo } from "../registry.js";

export interface WhatsAppActionContext {
  /** The connected socket. Reconnects replace it, so never capture it. */
  sock: WASocket;
  gateway: Gateway;
  /** Chat resolved from the numeric id; null only for store-only actions. */
  chat: WhatsAppChatInfo | null;
  /** Active scheduled-message timers, keyed by schedule id. */
  scheduledMessages: Map<string, ReturnType<typeof setTimeout>>;
}

type WhatsAppActionHandler = (
  body: Record<string, unknown>,
  chatId: number,
  ctx: WhatsAppActionContext,
) => Promise<ActionResult | null> | ActionResult | null;

export type WhatsAppActionHandlers = Record<string, WhatsAppActionHandler>;
