/**
 * Moderation tools — chat administration the platform grants admins: member
 * bans/mutes/promotions, chat permissions and identity, invite links, join
 * requests, and forum-topic management.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { chatIdSchema, snowflakeOrIdSchema } from "./schemas.js";

export const moderationTools: ToolDefinition[] = [
  {
    name: "moderate",
    description: `Administer the chat (requires the bot to be an admin with matching rights; Telegram reports missing rights in the error).

Member ops:
  moderate(op="ban", user_id=123) — ban; add minutes for a temp ban, delete_messages=true to also purge their messages
  moderate(op="unban", user_id=123)
  moderate(op="mute", user_id=123, minutes=60) — omit minutes to mute indefinitely
  moderate(op="unmute", user_id=123)
  moderate(op="promote", user_id=123) — grant standard admin rights; demote reverses
  moderate(op="set_admin_title", user_id=123, title="Ops") — custom title for an admin the bot promoted

Chat ops:
  moderate(op="set_permissions", permissions={"send_messages":true,"send_media":false}) — default member permissions
  moderate(op="create_invite_link", expire_minutes=60, member_limit=5, title="beta testers")
  moderate(op="revoke_invite_link", link="https://t.me/+...")
  moderate(op="list_join_requests") — pending join requests seen since startup
  moderate(op="approve_join_request", user_id=123) / decline_join_request
  moderate(op="set_chat_photo", file_path="/path/logo.png") / delete_chat_photo
  moderate(op="unpin_all")
  moderate(op="leave_chat") — the bot leaves the chat

Forum topics (supergroups with topics):
  moderate(op="create_topic", title="support")
  moderate(op="edit_topic", thread_id=77, title="support-eu")
  moderate(op="close_topic", thread_id=77) / reopen_topic / delete_topic`,
    schema: {
      op: z
        .enum([
          "ban",
          "unban",
          "mute",
          "unmute",
          "promote",
          "demote",
          "set_admin_title",
          "set_permissions",
          "create_invite_link",
          "revoke_invite_link",
          "list_join_requests",
          "approve_join_request",
          "decline_join_request",
          "set_chat_photo",
          "delete_chat_photo",
          "unpin_all",
          "leave_chat",
          "create_topic",
          "edit_topic",
          "close_topic",
          "reopen_topic",
          "delete_topic",
        ])
        .describe("The moderation operation"),
      user_id: snowflakeOrIdSchema
        .optional()
        .describe("Target user (member and join-request ops)"),
      minutes: z
        .number()
        .optional()
        .describe(
          "Duration for ban/mute in minutes; omit for indefinite. Telegram treats <1min or >366d as forever.",
        ),
      delete_messages: z
        .boolean()
        .optional()
        .describe("With op=ban: also delete the user's messages"),
      title: z
        .string()
        .optional()
        .describe(
          "Admin custom title (set_admin_title), invite-link name (create_invite_link), or topic name (create_topic/edit_topic)",
        ),
      permissions: z
        .record(z.string(), z.boolean())
        .optional()
        .describe(
          'Permission map for set_permissions, e.g. {"send_messages":true,"send_media":false,"invite_users":true}',
        ),
      expire_minutes: z
        .number()
        .optional()
        .describe("Invite link lifetime in minutes (create_invite_link)"),
      member_limit: z
        .number()
        .optional()
        .describe("Max joins via the invite link (create_invite_link)"),
      link: z
        .string()
        .optional()
        .describe("Invite link to revoke (revoke_invite_link)"),
      file_path: z
        .string()
        .optional()
        .describe("Image path for set_chat_photo"),
      thread_id: z
        .number()
        .optional()
        .describe("Forum topic id (edit/close/reopen/delete_topic)"),
      chat_id: chatIdSchema
        .optional()
        .describe("Target chat ID. Omit for the current chat."),
    },
    execute: (params, bridge) => bridge("moderate", params),
    frontends: ["telegram", "whatsapp"],
    tag: "moderation",
  },

  {
    name: "get_user_profile_photos",
    description:
      "Get a user's profile photos: total count plus file_ids (sendable/downloadable like any media).",
    schema: {
      user_id: snowflakeOrIdSchema,
      limit: z.number().optional().describe("Max photos to return (default 5)"),
    },
    execute: (params, bridge) => bridge("get_user_profile_photos", params),
    frontends: ["telegram", "whatsapp"],
    tag: "moderation",
  },
];
