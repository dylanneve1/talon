/**
 * Permission vocabulary shared by the member and chat ops.
 */

import type { ChatPermissions } from "grammy/types";

/** Seconds-from-now → Telegram until_date, honouring "omit = forever". */
export function untilDate(minutes: unknown): number | undefined {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(Date.now() / 1000) + Math.round(n * 60);
}

/**
 * Friendly permission names → ChatPermissions. `send_media` fans out to all
 * the per-kind media flags; raw `can_*` keys pass through untouched so the
 * full API surface stays reachable.
 */
export function toChatPermissions(
  raw: Record<string, boolean>,
): ChatPermissions {
  const out: Record<string, boolean> = {};
  const alias: Record<string, string[]> = {
    send_messages: ["can_send_messages"],
    send_media: [
      "can_send_audios",
      "can_send_documents",
      "can_send_photos",
      "can_send_videos",
      "can_send_video_notes",
      "can_send_voice_notes",
    ],
    send_polls: ["can_send_polls"],
    send_other: ["can_send_other_messages"],
    web_previews: ["can_add_web_page_previews"],
    change_info: ["can_change_info"],
    invite_users: ["can_invite_users"],
    pin_messages: ["can_pin_messages"],
    manage_topics: ["can_manage_topics"],
  };
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "boolean") continue;
    for (const target of alias[key] ?? (key.startsWith("can_") ? [key] : [])) {
      out[target] = value;
    }
  }
  return out;
}

/** Everything a mute takes away; unmute grants it back. */
export const FULL_MEMBER_PERMISSIONS: ChatPermissions = toChatPermissions({
  send_messages: true,
  send_media: true,
  send_polls: true,
  send_other: true,
  web_previews: true,
});

/** The workaday admin kit `promote` grants; demote sets all of these false. */
export const DEFAULT_ADMIN_RIGHTS = {
  can_manage_chat: true,
  can_delete_messages: true,
  can_restrict_members: true,
  can_pin_messages: true,
  can_invite_users: true,
  can_change_info: true,
  can_manage_topics: true,
  can_manage_video_chats: true,
};
