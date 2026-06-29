/**
 * Desktop action handler — the gateway-side bridge for the agent's delivery
 * tools. When the model calls `end_turn` / `send_message` / `react` / edit /
 * delete, the MCP tool POSTs an action to the gateway, which routes it here
 * by the active chat's numeric id. We translate each action into a Bridge
 * event the connected clients render, persist assistant messages to history,
 * and count deliveries on the gateway (so the dispatcher's trailing-prose
 * fallback knows the turn already produced output).
 */

import type { FrontendActionHandler, ActionResult } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import type { DesktopChats, ChatEntry } from "./chats.js";
import type { BridgeEvent, ClientButton } from "./protocol.js";

export type DesktopActionDeps = {
  chats: DesktopChats;
  gateway: Gateway;
  /** Persist + broadcast an assistant message; returns its numeric id. */
  emitAssistant: (
    entry: ChatEntry,
    text: string,
    buttons?: ClientButton[][],
  ) => number;
  broadcast: (event: BridgeEvent) => void;
};

/** Coerce gateway button rows (`[[{text,url,callback_data}]]`) to wire buttons. */
function toButtons(rows: unknown): ClientButton[][] | undefined {
  if (!Array.isArray(rows)) return undefined;
  const mapped: ClientButton[][] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const cells: ClientButton[] = [];
    for (const cell of row) {
      if (cell && typeof cell === "object") {
        const c = cell as Record<string, unknown>;
        const text = typeof c.text === "string" ? c.text : "";
        if (!text) continue;
        cells.push({
          text,
          url: typeof c.url === "string" ? c.url : undefined,
          data:
            typeof c.callback_data === "string" ? c.callback_data : undefined,
        });
      }
    }
    if (cells.length) mapped.push(cells);
  }
  return mapped.length ? mapped : undefined;
}

export function createDesktopActionHandler(
  deps: DesktopActionDeps,
): FrontendActionHandler {
  const { chats, gateway, emitAssistant, broadcast } = deps;

  return async (body, chatId): Promise<ActionResult | null> => {
    const action = typeof body.action === "string" ? body.action : "";
    const entry = chats.byNumeric(chatId);
    if (!entry) return { ok: false, error: "No active desktop chat" };

    switch (action) {
      case "send_message": {
        const text = String(body.text ?? "");
        const id = emitAssistant(entry, text);
        gateway.incrementMessages(chatId);
        return { ok: true, message_id: id };
      }

      case "send_message_with_buttons": {
        const text = String(body.text ?? "");
        const id = emitAssistant(entry, text, toButtons(body.rows));
        gateway.incrementMessages(chatId);
        return { ok: true, message_id: id };
      }

      case "react": {
        const messageId = String(body.message_id ?? "");
        const emoji = String(body.emoji ?? "👍");
        broadcast({ kind: "reaction", chatId: entry.id, messageId, emoji });
        gateway.incrementMessages(chatId);
        return { ok: true };
      }

      case "edit_message": {
        const messageId = String(body.message_id ?? "");
        const text = String(body.text ?? "");
        broadcast({
          kind: "message_edited",
          chatId: entry.id,
          messageId,
          text,
        });
        return { ok: true };
      }

      case "delete_message": {
        const messageId = String(body.message_id ?? "");
        broadcast({ kind: "message_deleted", chatId: entry.id, messageId });
        return { ok: true };
      }

      case "get_chat_info":
        return {
          ok: true,
          id: entry.numericId,
          type: "private",
          title: entry.title,
        };

      // Typing is driven by the dispatcher via sendTyping → no-op ack here.
      case "send_chat_action":
        return { ok: true };

      default:
        // Let the gateway try plugin + shared actions (history, web, cron…).
        return null;
    }
  };
}
