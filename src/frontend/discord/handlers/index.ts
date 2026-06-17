/**
 * Discord message handlers — mirrors the telegram handlers/ layout.
 *
 *   - `state`    — shared maps/sets (chat registry, access config, queues,
 *                  rate-limit windows, cooldowns)
 *   - `registry` — numeric/string chatId → Discord channel info accessors
 *   - `access`   — DM/guild/channel allowlists, admin checks, mention gating,
 *                  unauthorized handling, rate limiting
 *   - `context`  — sender/reply context, attachment download/classify,
 *                  chunked send
 *   - `delivery` — the agent run + reply pipeline (processAndReply)
 *   - `queue`    — per-chat debounce queue
 *   - `messages` — the messageCreate handler (handleMessage)
 *
 * Re-exports the same public surface the old single-file module exposed.
 */

export type { DiscordChatInfo } from "./registry.js";
export {
  registerDiscordChat,
  lookupDiscordChat,
  lookupDiscordChatByString,
} from "./registry.js";
export {
  setAccessControl,
  isAdmin,
  getAccessSnapshot,
  isAccessAllowed,
  isInteractionAllowed,
  shouldHandleInGuild,
  isUserRateLimited,
} from "./access.js";
export { getSenderName, sendChunked } from "./context.js";
export { handleMessage } from "./messages.js";
