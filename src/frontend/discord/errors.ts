/**
 * Discord API error code mapper.
 *
 * discord.js throws `DiscordAPIError` instances with numeric `.code` set to
 * the JSON error code from Discord's REST response body. This helper turns the
 * raw error into a clean `{ok:false, error}` shape that the agent (LLM) can
 * read without losing the original message in a stack trace.
 *
 * Code reference: https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
 */

import type { ActionResult } from "../../core/types.js";

type DiscordAPIErrorLike = {
  code?: number;
  status?: number;
  message?: string;
  rawError?: { code?: number };
};

/** Extract numeric JSON error code, if this looks like a DiscordAPIError. */
function discordErrorCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as DiscordAPIErrorLike;
  if (typeof e.code === "number") return e.code;
  if (typeof e.rawError?.code === "number") return e.rawError.code;
  return null;
}

/**
 * Map a DiscordAPIError into a friendly ActionResult. Returns null if the
 * error isn't a recognized Discord error — caller should fall back to its
 * own generic handler in that case.
 */
export function mapDiscordError(
  err: unknown,
  context: string,
): ActionResult | null {
  const code = discordErrorCode(err);
  if (code === null) return null;
  const raw = err instanceof Error ? err.message : String(err);
  switch (code) {
    case 10003:
      return { ok: false, error: `Unknown channel (${context})` };
    case 10008:
      return {
        ok: false,
        error: `Unknown message — it was likely deleted before ${context} could run`,
      };
    case 10013:
      return { ok: false, error: `Unknown user (${context})` };
    case 10014:
      return { ok: false, error: `Unknown emoji (${context})` };
    case 10026:
      return { ok: false, error: `Unknown sticker (${context})` };
    case 20029:
      return {
        ok: false,
        error: `Disallowed words/content (${context}): ${raw}`,
      };
    case 30005:
      return {
        ok: false,
        error: `Maximum number of guild roles reached (${context})`,
      };
    case 30007:
      return {
        ok: false,
        error: `Webhook rate limit hit; back off and retry (${context})`,
      };
    case 30008:
      return {
        ok: false,
        error: `Max reactions on this message (${context})`,
      };
    case 40005:
      return {
        ok: false,
        error: `Attachment too large for this channel/guild (${context})`,
      };
    case 40060:
      return {
        ok: false,
        error: `Interaction already acknowledged (${context}) — this is a race condition, retry the action`,
      };
    case 50001:
      return {
        ok: false,
        error: `Missing access — bot can't see this channel (${context})`,
      };
    case 50007:
      return {
        ok: false,
        error: `Cannot DM this user — they have DMs disabled or blocked the bot`,
      };
    case 50013:
      return {
        ok: false,
        error: `Missing permissions — bot lacks the required guild/channel permission for ${context}`,
      };
    case 50021:
      return {
        ok: false,
        error: `Cannot execute on a system message (${context})`,
      };
    case 50035:
      return { ok: false, error: `Invalid form body (${context}): ${raw}` };
    case 50036:
      return {
        ok: false,
        error: `Bot is not in the guild that owns this resource (${context})`,
      };
    default:
      return {
        ok: false,
        error: `Discord error ${code} during ${context}: ${raw}`,
      };
  }
}

/**
 * Max attachment size in bytes for a given guild's boost tier. Per
 * https://discord.com/developers/docs/resources/guild#guild-object-premium-tier:
 *   Tier 0 (no boosts)  10 MB
 *   Tier 1              25 MB
 *   Tier 2              50 MB
 *   Tier 3             100 MB
 *
 * DMs use Tier 0 (10 MB) since 2024-08; previously 25 MB.
 */
export function maxAttachmentBytes(
  guild: { premiumTier?: number } | null | undefined,
): number {
  const tier = guild?.premiumTier ?? 0;
  switch (tier) {
    case 3:
      return 100 * 1024 * 1024;
    case 2:
      return 50 * 1024 * 1024;
    case 1:
      return 25 * 1024 * 1024;
    default:
      return 10 * 1024 * 1024;
  }
}
