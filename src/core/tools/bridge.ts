/**
 * Bridge utilities — shared by the unified MCP server.
 *
 * Extracted from the old per-backend tools.ts files so there's
 * exactly one copy of callBridge / textResult.
 */

import type { BridgeFunction } from "./types.js";

/**
 * Create a bridge caller bound to a default URL and chat.
 *
 * The default `chatId` is what the MCP subprocess was spawned with (the
 * TALON_CHAT_ID env). For session-bound calls (chat mode) that's the
 * active chat. For session-less calls (heartbeat / dream outbound), the
 * env chat is empty/sentinel and the model passes `chat_id` in tool
 * params — the bridge promotes that explicit value to `_chatId` so the
 * gateway routes to it, AND keeps `chat_id` in the body as a signal
 * that this is an explicit-routing request (the gateway uses that signal
 * to skip the active-context-required check it normally enforces).
 */
export function createBridge(
  bridgeUrl: string,
  chatId: string,
): BridgeFunction {
  return async (action, params) => {
    const explicitChatId =
      params &&
      typeof (params as Record<string, unknown>).chat_id !== "undefined"
        ? String((params as Record<string, unknown>).chat_id)
        : null;
    const effectiveChatId = explicitChatId ?? chatId;
    const resp = await fetch(`${bridgeUrl}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // chat_id stays in body when set — gateway uses its presence as the
      // "explicit routing" signal. _chatId is the routing key either way.
      body: JSON.stringify({ action, ...params, _chatId: effectiveChatId }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Bridge error (${resp.status}): ${text}`);
    }
    return resp.json();
  };
}

/** Wrap a bridge result into the MCP content format. */
export function textResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const r = result as { text?: string; error?: string };
  return {
    content: [
      { type: "text" as const, text: r.text ?? JSON.stringify(result) },
    ],
  };
}
