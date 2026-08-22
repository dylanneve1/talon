/**
 * WhatsApp-specific action handlers.
 *
 * Handles the MCP tool actions that need the WhatsApp socket.
 * Platform-agnostic actions (cron, fetch_url, in-memory history) are
 * served by core/engine/gateway-actions before this is reached, and any
 * action this module doesn't claim returns null so that fallback still
 * applies — which is how `read_history` and friends work here without a
 * WhatsApp-specific implementation.
 *
 * Split by responsibility (mirrors the telegram/discord actions/ layout):
 *   - shared     — tryAction, media/quote resolution, send helpers
 *   - messaging  — text, replies, reactions, edits, deletes, pins, presence
 *   - media      — images, video, audio, documents, polls, locations, …
 *   - chat-info  — group metadata, members, titles, media download
 *   - moderation — the `moderate` op switch
 */

import type { WASocket } from "baileys";
import type { Gateway } from "../../../core/engine/gateway.js";
import type { ActionResult } from "../../../core/types.js";
import { lookupWhatsAppChat } from "../registry.js";
import { chatInfoHandlers } from "./chat-info.js";
import { mediaHandlers } from "./media.js";
import { messagingHandlers } from "./messaging.js";
import { moderationHandlers } from "./moderation.js";
import type { WhatsAppActionContext, WhatsAppActionHandlers } from "./types.js";

// Null-prototype so a request `action` of "toString" / "constructor" can't
// resolve an inherited Object.prototype method via `handlers[action]`.
const handlers: WhatsAppActionHandlers = Object.assign(Object.create(null), {
  ...messagingHandlers,
  ...mediaHandlers,
  ...chatInfoHandlers,
  ...moderationHandlers,
});

/** Actions that operate on the store alone and need no resolved chat. */
const CHATLESS_ACTIONS = new Set(["cancel_scheduled", "list_scheduled"]);

export function createWhatsAppActionHandler(
  getSock: () => WASocket | null,
  gateway: Gateway,
) {
  const scheduledMessages = new Map<string, ReturnType<typeof setTimeout>>();

  return async (
    body: Record<string, unknown>,
    chatId: number,
  ): Promise<ActionResult | null> => {
    const action = body.action as string;
    const handler = handlers[action];
    if (!handler) return null; // not a WhatsApp action — let the core try

    const sock = getSock();
    if (!sock) {
      return { ok: false, error: "WhatsApp socket is not connected" };
    }

    const chat = lookupWhatsAppChat(chatId) ?? null;
    if (!chat && !CHATLESS_ACTIONS.has(action)) {
      return {
        ok: false,
        error:
          `No WhatsApp chat known for id ${chatId} — Talon learns a chat's ` +
          `JID from its first message.`,
      };
    }

    const ctx: WhatsAppActionContext = {
      sock,
      gateway,
      chat,
      scheduledMessages,
    };
    return handler(body, chatId, ctx);
  };
}
