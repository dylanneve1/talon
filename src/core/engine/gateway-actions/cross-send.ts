/**
 * Cross-frontend send — the server side of the `send_via` tool.
 *
 * A chat-free shared action: any session (an active Telegram chat, the
 * heartbeat, a dream run) delivers a plain text message through ANY
 * enabled messaging frontend by naming it explicitly. Explicit is the
 * point — the gateway's normal chat_id routing infers the owning
 * frontend from the numeric id's shape, and WhatsApp's hash-derived ids
 * also match the Telegram matcher, so a cross-frontend send routed that
 * way lands on the wrong platform once the originating turn's context
 * is cleared.
 *
 * Core never imports src/frontend (dependency-cruiser enforces it), so
 * dispatch goes through a broker: `Gateway.registerFrontendHandler`
 * mirrors each frontend's action handler here, and the action calls the
 * target's own `send_message` — the one send action every messaging
 * frontend implements. A numeric target doubles as the handler's chatId
 * key, so id-addressed frontends (telegram, discord, teams, native)
 * need no changes; non-numeric forms (WhatsApp phone numbers, wa_* ids)
 * ride in `body.target` for the frontend's adapter to resolve.
 */

import type { FrontendActionHandler } from "../../types.js";
import type { SharedActionHandlers } from "./types.js";

const targets = new Map<string, FrontendActionHandler>();

/**
 * Broker registration — called by `Gateway.registerFrontendHandler` as
 * each frontend wires up (and with null on deregistration), so the set
 * of reachable targets is exactly the set of enabled frontends.
 */
export function registerCrossSendTarget(
  name: string,
  handler: FrontendActionHandler | null,
): void {
  if (handler === null) targets.delete(name);
  else targets.set(name, handler);
}

export const crossSendHandlers: SharedActionHandlers = {
  send_via: async (body) => {
    const frontend = String(body.frontend ?? "")
      .trim()
      .toLowerCase();
    const target = String(body.target ?? "").trim();
    const text = String(body.text ?? "");
    if (!frontend) {
      return { ok: false, error: "send_via: frontend is required" };
    }
    if (!target) {
      return { ok: false, error: "send_via: target is required" };
    }
    if (!text.trim()) {
      return { ok: false, error: "send_via: text is required" };
    }
    const handler = targets.get(frontend);
    if (!handler) {
      const enabled = [...targets.keys()].sort().join(", ") || "none";
      return {
        ok: false,
        error: `send_via: the ${frontend} frontend is not enabled (enabled: ${enabled})`,
      };
    }
    // A numeric target is the handler's chatId key; other forms travel in
    // body.target for the frontend's adapter to resolve. 0 is the same
    // "no chat" sentinel the chat-free dispatch itself uses.
    const numericTarget = /^-?\d+$/.test(target) ? Number(target) : 0;
    const result = await handler(
      { action: "send_message", text, target },
      numericTarget,
    );
    if (!result) {
      return {
        ok: false,
        error: `send_via: the ${frontend} frontend does not implement send_message`,
      };
    }
    return result;
  },
};

/**
 * send_via is chat-free by design: it reads only its own explicit target
 * and the broker, so it stays reachable from heartbeat/background runs —
 * and skipping chat resolution is what keeps the wrong-frontend numeric
 * routing hazard out of the path entirely.
 */
export const crossSendChatFreeActions: ReadonlySet<string> = new Set([
  "send_via",
]);
