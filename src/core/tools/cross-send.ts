import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * Cross-frontend send. Deliberately NOT frontend-restricted (the meshTools
 * pattern): the whole point is reaching a DIFFERENT enabled frontend than
 * the one the session lives on — a Telegram chat messaging a WhatsApp
 * number, the heartbeat reaching WhatsApp when only telegram-tools is
 * mounted. The gateway serves it as a chat-free action (see
 * engine/gateway-actions/cross-send.ts), so it works from background runs
 * with no ambient chat, and the target frontend is named EXPLICITLY —
 * never inferred from the shape of a numeric id.
 */
export const crossSendTools: ToolDefinition[] = [
  {
    name: "send_via",
    description: `Send a plain text message through ANY enabled messaging frontend — including one this chat does not live on. Use it to reach someone on another platform (e.g. from Telegram or a heartbeat run, message a WhatsApp number). For the current chat, keep using the normal delivery tools (end_turn / send / send_message).

Target forms:
- whatsapp: a phone number with country code ("+353871234567" or "353871234567"), a wa_dm_<number>/wa_group_<id> chat id, or a raw JID; a bare numeric chat id works only for chats already seen since startup
- telegram / discord / teams / native: the numeric chat id, as a string (Telegram supergroups/channels are negative, DMs positive)

Examples:
  send_via(frontend="whatsapp", target="+353871234567", text="On my way")
  send_via(frontend="telegram", target="-1001426819337", text="Build is green")

Fails with a clear error when the named frontend is not enabled or not connected.`,
    schema: {
      frontend: z
        .enum(["telegram", "whatsapp", "discord", "teams", "native"])
        .describe("Messaging frontend to deliver through."),
      target: z
        .string()
        .describe(
          "Destination chat: numeric chat id as a string; for WhatsApp also a phone number with country code or a wa_dm_/wa_group_ id.",
        ),
      text: z
        .string()
        .describe(
          "Message text. Markdown supported where the platform supports it.",
        ),
    },
    execute: (params, bridge) => bridge("send_via", params),
    tag: "messaging",
  },
];
