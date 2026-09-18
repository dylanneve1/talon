/**
 * Moderation actions — the `moderate` tool's member/chat/topic operations,
 * plus profile-photo lookup.
 *
 * Handlers call the Bot API directly and let Telegram's own errors surface
 * (missing admin rights come back as descriptive 400s the model can read);
 * pre-checking rights here would just race the real check.
 *
 * `moderate` dispatches on `body.op` through the table below:
 *   - `members` — ban / unban / mute / unmute / promote / demote /
 *                 set_admin_title / *_join_request(s)
 *   - `chat`    — set_permissions / *_invite_link / *_chat_photo /
 *                 unpin_all / leave_chat
 *   - `topics`  — create / edit / close / reopen / delete_topic
 */

import { toPositiveId } from "../shared.js";
import type { TelegramActionHandlers } from "../types.js";
import { memberOps } from "./members.js";
import { chatOps } from "./chat.js";
import { topicOps } from "./topics.js";
import type { ModerationOps } from "./types.js";

// Null-prototype so an `op` of "toString" / "constructor" / etc. can't
// resolve an inherited Object.prototype method via `ops[op]`.
export const MODERATION_OPS: ModerationOps = Object.assign(
  Object.create(null),
  {
    ...memberOps,
    ...chatOps,
    ...topicOps,
  },
);

/** Ops that fail up front without a `user_id`. */
export const OPS_NEEDING_USER = [
  "ban",
  "unban",
  "mute",
  "unmute",
  "promote",
  "demote",
  "set_admin_title",
  "approve_join_request",
  "decline_join_request",
];

export const moderationHandlers: TelegramActionHandlers = {
  moderate: async (body, chatId, ctx) => {
    const op = String(body.op ?? "");
    const userId = toPositiveId(body.user_id);
    if (OPS_NEEDING_USER.includes(op) && userId === undefined)
      return { ok: false, error: `${op}: user_id is required` };
    const run = MODERATION_OPS[op];
    if (!run) return { ok: false, error: `Unknown moderation op: ${op}` };
    return run({ op, body, chatId, ctx, userId });
  },

  get_user_profile_photos: async (body, _chatId, { bot }) => {
    const userId = toPositiveId(body.user_id);
    if (userId === undefined)
      return { ok: false, error: "user_id is required" };
    const limit = toPositiveId(body.limit) ?? 5;
    const photos = await bot.api.getUserProfilePhotos(userId, {
      limit: Math.min(limit, 100),
    });
    return {
      ok: true,
      total: photos.total_count,
      // Largest size of each photo; its file_id sends/downloads like media.
      file_ids: photos.photos.map((sizes) => sizes[sizes.length - 1].file_id),
    };
  },
};
