import { z } from "zod";
import type { ToolDefinition } from "../types.js";

/**
 * WhatsApp account management. Deliberately NOT frontend-restricted
 * (the same reasoning as crossSendTools): the account being managed and
 * the session managing it are usually on different frontends — a
 * Telegram DM setting the WhatsApp profile photo, or a heartbeat run
 * with no ambient chat. The gateway serves it as a chat-free action
 * (see engine/gateway-actions/whatsapp-account.ts), so it needs no
 * resolved WhatsApp conversation to work.
 */
export const whatsappTools: ToolDefinition[] = [
  {
    name: "whatsapp_account",
    description: `Read and change the bot's own WhatsApp account — profile, privacy, blocklist, presence. Works from any frontend (it addresses the WhatsApp connection, not a chat), and fails with a clear error when the WhatsApp frontend is not enabled.

Profile:
  whatsapp_account(op="get_profile") — number, display name, about text, profile photo URL
  whatsapp_account(op="set_name", name="Claudius")
  whatsapp_account(op="set_about", text="Running on Talon") — empty text clears it
  whatsapp_account(op="set_photo", file_path="media/avatar.jpg") — or url=...; square images work best
  whatsapp_account(op="remove_photo")

Other people:
  whatsapp_account(op="get_user_profile", contact="+353871234567") — their about + photo, as your account can see them

Privacy (op="get_privacy" lists the current values):
  whatsapp_account(op="set_privacy", setting="last_seen", value="contacts")
  settings: last_seen, online, profile_photo, about, groups_add (all | contacts | contact_blacklist | none¹),
            read_receipts (all | none), calls (all | known), messages (all | contacts),
            online also accepts match_last_seen
  ¹ groups_add has no "none"; online takes only all/match_last_seen.
  whatsapp_account(op="set_disappearing", duration="7d") — default timer for NEW chats: off, 24h, 7d, 90d, or seconds

Blocking and presence:
  whatsapp_account(op="get_blocklist")
  whatsapp_account(op="block", contact="+353871234567") / op="unblock"
  whatsapp_account(op="set_presence", presence="available") — or "unavailable" to appear offline

Changes here are real and immediately visible to that account's contacts.`,
    schema: {
      op: z
        .enum([
          "get_profile",
          "get_user_profile",
          "set_name",
          "set_about",
          "set_photo",
          "remove_photo",
          "get_privacy",
          "set_privacy",
          "set_disappearing",
          "get_blocklist",
          "block",
          "unblock",
          "set_presence",
        ])
        .describe("The account operation to perform."),
      name: z.string().optional().describe("New display name (set_name)."),
      text: z
        .string()
        .optional()
        .describe("New about/status text (set_about); empty clears it."),
      file_path: z
        .string()
        .optional()
        .describe("Workspace image for set_photo."),
      url: z.string().optional().describe("Public image URL for set_photo."),
      contact: z
        .string()
        .optional()
        .describe(
          "Who to act on for get_user_profile / block / unblock: a phone number with country code, or a JID. Not an internal id — deliberately not named user_id.",
        ),
      setting: z
        .enum([
          "last_seen",
          "online",
          "profile_photo",
          "about",
          "read_receipts",
          "groups_add",
          "calls",
          "messages",
        ])
        .optional()
        .describe("Which privacy knob to change (set_privacy)."),
      value: z
        .string()
        .optional()
        .describe(
          "New privacy value (set_privacy) — the accepted set depends on the setting.",
        ),
      duration: z
        .string()
        .optional()
        .describe(
          "Default disappearing timer for new chats (set_disappearing): off, 24h, 7d, 90d, or seconds.",
        ),
      presence: z
        .enum(["available", "unavailable"])
        .optional()
        .describe("Presence to broadcast (set_presence)."),
    },
    execute: (params, bridge) => bridge("whatsapp_account", params),
    tag: "admin",
  },
];
