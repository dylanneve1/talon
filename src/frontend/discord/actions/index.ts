/**
 * Discord-specific action handlers.
 *
 * Handles MCP tool actions that require the Discord API. Platform-agnostic
 * actions (cron, fetch_url, history) are handled by core/engine/gateway-actions
 * before this is called. The gateway maps a request to this handler by numeric
 * chatId; we resolve it back to a Discord channel via the registry maintained
 * in handlers/.
 *
 * Split by responsibility (mirrors the telegram actions/ layout):
 *   - shared    — tryAction + resolveChannel + buildButtonRows
 *   - messaging — send/reply/edit/delete/pin/forward/react/buttons/schedule
 *   - media     — attachments, stickers, polls, locations, contacts, dice
 *   - chat-info — chat/member info, titles, pinned, history/search,
 *                 Telegram-only no-ops
 *
 * `createDiscordActionHandler` merges the per-domain maps and dispatches on
 * `body.action`, preserving the original factory's signature, the up-front
 * channel resolution + `needsChannel` guard, and per-instance scheduled-timer
 * state.
 */

import type { Client } from "discord.js";
import type { Gateway } from "../../../core/engine/gateway.js";
import type { ActionResult } from "../../../core/types.js";
import { resolveChannel } from "./shared.js";
import { messagingHandlers } from "./messaging.js";
import { mediaHandlers } from "./media.js";
import { chatInfoHandlers } from "./chat-info.js";
import type { DiscordActionContext, DiscordActionHandlers } from "./types.js";

// Null-prototype so a request `action` of "toString" / "constructor" / etc.
// can't resolve an inherited Object.prototype method via `handlers[action]`.
const handlers: DiscordActionHandlers = Object.assign(Object.create(null), {
  ...messagingHandlers,
  ...mediaHandlers,
  ...chatInfoHandlers,
});

export function createDiscordActionHandler(client: Client, gateway: Gateway) {
  const scheduledMessages = new Map<string, ReturnType<typeof setTimeout>>();

  return async (
    body: Record<string, unknown>,
    chatId: number,
  ): Promise<ActionResult | null> => {
    const action = body.action as string;
    const handler = handlers[action];
    if (!handler) return null; // not a Discord action

    const channel = await resolveChannel(client, chatId);

    // For non-channel actions (e.g. cancel_scheduled) that don't need a
    // resolved channel, fall through. Most Discord actions need it — return
    // error if missing.
    const needsChannel = action !== "cancel_scheduled";
    if (needsChannel && !channel) {
      return {
        ok: false,
        error: `Discord channel not resolvable for chat ${chatId}`,
      };
    }

    const ctx: DiscordActionContext = {
      client,
      gateway,
      scheduledMessages,
      channel,
    };
    return handler(body, chatId, ctx);
  };
}
