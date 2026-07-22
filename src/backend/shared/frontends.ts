/**
 * Frontend-list helpers shared across backends.
 *
 * Every backend needs "which frontends get an MCP tool server?" at
 * spawn time. Identity, chat-id ownership, and the messaging trait are
 * owned by the frontend registry (`core/frontend-runtime`) — these
 * helpers are thin views over it, kept for their call-site-friendly
 * shapes.
 */

import {
  getFrontendDescriptor,
  resolveOwnerFrontendId,
} from "../../core/frontend-runtime/routing.js";

/**
 * Normalise a config `frontend` value (string or array, possibly
 * undefined) to the list of messaging frontends — i.e. those that
 * need an MCP tool server spawned. `terminal` is excluded: it has no
 * outbound messaging surface (the agent runs to stdout). Unknown ids
 * are kept — an unregistered frontend must fail loudly downstream,
 * not silently lose its tools.
 */
export function nonTerminalFrontends(
  frontend: string | readonly string[] | undefined,
): readonly string[] {
  if (!frontend) return [];
  const all = Array.isArray(frontend) ? frontend : [frontend as string];
  return all.filter((f) => getFrontendDescriptor(f)?.messaging !== false);
}

/**
 * The messaging frontend that owns a chat, inferred from the chat-id
 * shape (the same registry matchers the gateway uses to route
 * actions). Returns null for cross-surface contexts — the heartbeat
 * sentinel, isolated one-shots, terminal sessions.
 */
export function frontendForChatId(chatId: string): string | null {
  return resolveOwnerFrontendId(chatId);
}

/**
 * Which frontends' tool servers a chat's turn should register.
 *
 * A chat owned by one messaging frontend gets exactly that frontend's
 * tools: a native-app conversation must see `native-tools`, not a
 * `telegram-tools` server that happens to share the daemon — the
 * model reads surface identity out of tool names, and stray
 * `mcp__telegram-tools__*` entries in a native chat are both confusing
 * UI and an invitation to deliver the reply to the wrong surface.
 *
 * Chats with no owning frontend (heartbeat sentinel, one-shot cron,
 * terminal sessions) keep every configured messaging frontend: those
 * contexts legitimately reach across surfaces via explicit chat_id.
 */
export function frontendsForChat(
  chatId: string,
  configured: readonly string[],
): readonly string[] {
  const owner = frontendForChatId(chatId);
  if (owner && configured.includes(owner)) return [owner];
  return configured;
}
