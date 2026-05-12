/**
 * Messaging tools — send, end_turn, react, edit, delete, forward, pin/unpin,
 * stop poll.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { chatIdSchema, idSchema } from "./schemas.js";

export const messagingTools: ToolDefinition[] = [
  // ── end_turn — explicit final-reply delivery ──────────────────────────
  // Schema-typed alternative to relying on a trailing-text fallback. The
  // model is taught that this is the canonical way to deliver its final
  // reply. Functionally a thin wrapper over send(type="text") + reply_to +
  // buttons; the value is in the EXPLICIT semantic ("this ends my turn")
  // and that the model sees a single tool whose purpose is unambiguous.
  //
  // The output stream is private scratchpad by contract. If the model
  // writes trailing prose without calling end_turn or send, the handler
  // re-prompts ONCE in the same session with a flow-violation reminder
  // so the model can retry properly. Persistent violation after retry
  // results in silent drop + `scratchpad.trailing_text_dropped` counter.
  // `end_turn` is the documented happy path.
  {
    name: "end_turn",
    description: `End your current turn and deliver your final reply to the user. This is the canonical way to respond.

Call this AT MOST ONCE per turn — it should be the last tool you call. Behaves like send(type="text") with reply_to and buttons support, but the name makes the intent explicit: this is the message that ends the turn.

Examples:
  end_turn(text="Got it sur") — plain reply
  end_turn(text="On it", reply_to=12345) — reply to a specific message ID
  end_turn(text="Pick one", buttons=[[{"text":"A","callback_data":"a"}]]) — with buttons
  end_turn() — silent end (no message; useful when you already replied via earlier send/react calls)

Notes:
- For richer message types (photos, polls, voice, scheduled messages, multi-target), use the send tool — those don't fit "final reply" semantics.
- The output stream is private scratchpad. If you write prose without calling end_turn or send, the handler re-prompts you ONCE with a flow-violation reminder so you can retry properly. Persistent violation drops the prose silently. end_turn is the documented happy path.`,
    schema: {
      text: z
        .string()
        .optional()
        .describe(
          "Final reply text. Supports Markdown. Omit to end the turn silently (no message sent).",
        ),
      reply_to: idSchema
        .optional()
        .describe("Message ID to reply to (typically the user's [msg_id:N])"),
      buttons: z
        .array(
          z.array(
            z.object({
              text: z.string(),
              url: z.string().optional(),
              callback_data: z.string().optional(),
            }),
          ),
        )
        .optional()
        .describe("Inline keyboard button rows"),
    },
    execute: async (params, bridge) => {
      // Telegram path: routes to the same bridge actions as send(type="text")
      // so bridgeMessageCount, dedup, and audit logging all stay consistent.
      if (typeof params.text !== "string" || params.text.trim() === "") {
        // Silent end — no bridge call. The handler still sees the tool was
        // invoked (via deliveredTextNorms staying empty), and trailing-text
        // fallback won't fire because there was no trailing prose.
        return { ok: true, silent: true };
      }
      if (params.buttons) {
        return bridge("send_message_with_buttons", {
          text: params.text,
          rows: params.buttons,
          reply_to_message_id: params.reply_to,
        });
      }
      return bridge("send_message", {
        text: params.text,
        reply_to_message_id: params.reply_to,
      });
    },
    frontends: ["telegram", "teams"],
    tag: "messaging",
    endsTurn: true,
  },

  // ── Telegram unified send ─────────────────────────────────────────────
  {
    name: "send",
    description: `Send content to the current Telegram chat. Supports text, photos, videos, files, audio, voice, stickers, polls, locations, contacts, dice, and GIFs.

Examples:
  Text: send(type="text", text="Hello!")
  Reply: send(type="text", text="Yes!", reply_to=12345)
  With buttons: send(type="text", text="Pick one", buttons=[[{"text":"A","callback_data":"a"}]])
  Photo: send(type="photo", file_path="/path/to/img.jpg", caption="Look!")
  File: send(type="file", file_path="/path/to/report.pdf")
  Audio: send(type="audio", file_path="/path/to/song.mp3", title="Song Name", performer="Artist")
  Poll: send(type="poll", question="Best language?", options=["Rust","Go","TS"])
  Dice: send(type="dice")
  Location: send(type="location", latitude=37.7749, longitude=-122.4194)
  Sticker: send(type="sticker", file_id="CAACAgI...")`,
    schema: {
      type: z
        .enum([
          "text",
          "photo",
          "file",
          "video",
          "voice",
          "audio",
          "animation",
          "sticker",
          "poll",
          "location",
          "contact",
          "dice",
        ])
        .describe("Content type to send"),
      text: z
        .string()
        .optional()
        .describe("Message text (for type=text). Supports Markdown."),
      reply_to: idSchema.optional().describe("Message ID to reply to"),
      file_path: z
        .string()
        .optional()
        .describe("Workspace file path (for photo/file/video/voice/animation)"),
      file_id: z.string().optional().describe("Telegram file_id (for sticker)"),
      caption: z.string().optional().describe("Caption for media"),
      buttons: z
        .array(
          z.array(
            z.object({
              text: z.string(),
              url: z.string().optional(),
              callback_data: z.string().optional(),
            }),
          ),
        )
        .optional()
        .describe("Inline keyboard button rows"),
      question: z.string().optional().describe("Poll question"),
      options: z.array(z.string()).optional().describe("Poll options"),
      is_anonymous: z.boolean().optional().describe("Anonymous poll"),
      correct_option_id: z
        .number()
        .optional()
        .describe("Quiz correct answer index"),
      explanation: z.string().optional().describe("Quiz explanation"),
      latitude: z.number().optional().describe("Location latitude"),
      longitude: z.number().optional().describe("Location longitude"),
      phone_number: z.string().optional().describe("Contact phone"),
      first_name: z.string().optional().describe("Contact first name"),
      last_name: z.string().optional().describe("Contact last name"),
      title: z.string().optional().describe("Audio title (for type=audio)"),
      performer: z
        .string()
        .optional()
        .describe("Audio performer/artist (for type=audio)"),
      emoji: z.string().optional().describe("Dice emoji (🎲🎯🏀⚽🎳🎰)"),
      delay_seconds: z
        .number()
        .optional()
        .describe("Schedule: delay before sending (1-3600)"),
      chat_id: chatIdSchema
        .optional()
        .describe(
          "Target chat ID. Omit to send to the current chat (chat mode). Required from heartbeat mode where there is no ambient chat — use list_chats or known IDs from memory. Telegram supergroup/channel IDs are negative (e.g. -1001426819337); user DMs are positive.",
        ),
    },
    execute: async (params, bridge) => {
      const { type } = params;
      // Thread chat_id through to every bridge call so heartbeat / dream
      // outbound (no ambient chat) gets routed by the explicit chat_id.
      // `createBridge` at src/core/tools/bridge.ts:29 reads
      // `params.chat_id` from the bridge payload (NOT from the
      // tool-input params) and promotes it to `_chatId` for the
      // gateway. If we don't include chat_id here, the bridge falls
      // back to the spawn-time TALON_CHAT_ID env (the "heartbeat"
      // sentinel) and the gateway rejects with "No active chat
      // context and no explicit numeric chat_id".
      const chat_id = params.chat_id;
      switch (type) {
        case "text": {
          if (params.delay_seconds) {
            return bridge("schedule_message", {
              text: params.text,
              delay_seconds: params.delay_seconds,
              chat_id,
            });
          }
          if (params.buttons) {
            return bridge("send_message_with_buttons", {
              text: params.text,
              rows: params.buttons,
              reply_to_message_id: params.reply_to,
              chat_id,
            });
          }
          return bridge("send_message", {
            text: params.text,
            reply_to_message_id: params.reply_to,
            chat_id,
          });
        }
        case "photo":
          return bridge("send_photo", {
            file_path: params.file_path,
            caption: params.caption,
            reply_to: params.reply_to,
            chat_id,
          });
        case "file":
          return bridge("send_file", {
            file_path: params.file_path,
            caption: params.caption,
            reply_to: params.reply_to,
            chat_id,
          });
        case "video":
          return bridge("send_video", {
            file_path: params.file_path,
            caption: params.caption,
            reply_to: params.reply_to,
            chat_id,
          });
        case "voice":
          return bridge("send_voice", {
            file_path: params.file_path,
            caption: params.caption,
            reply_to: params.reply_to,
            chat_id,
          });
        case "audio":
          return bridge("send_audio", {
            file_path: params.file_path,
            caption: params.caption,
            title: params.title,
            performer: params.performer,
            reply_to: params.reply_to,
            chat_id,
          });
        case "animation":
          return bridge("send_animation", {
            file_path: params.file_path,
            caption: params.caption,
            reply_to: params.reply_to,
            chat_id,
          });
        case "sticker":
          return bridge("send_sticker", {
            file_id: params.file_id,
            reply_to: params.reply_to,
            chat_id,
          });
        case "poll":
          return bridge("send_poll", {
            question: params.question,
            options: params.options,
            is_anonymous: params.is_anonymous,
            correct_option_id: params.correct_option_id,
            explanation: params.explanation,
            type: params.correct_option_id !== undefined ? "quiz" : "regular",
            chat_id,
          });
        case "location":
          return bridge("send_location", {
            latitude: params.latitude,
            longitude: params.longitude,
            chat_id,
          });
        case "contact":
          return bridge("send_contact", {
            phone_number: params.phone_number,
            first_name: params.first_name,
            last_name: params.last_name,
            chat_id,
          });
        case "dice":
          return bridge("send_dice", { emoji: params.emoji, chat_id });
        default:
          return { ok: false, error: `Unknown type: ${type}` };
      }
    },
    frontends: ["telegram"],
    tag: "messaging",
  },

  // ── Teams send_message ────────────────────────────────────────────────
  {
    name: "send_message",
    description: `Send a message to the Teams chat. Supports Markdown formatting.

Examples:
  send_message(text="Hello!")
  send_message(text="Here's a **bold** message with \`code\`")`,
    schema: {
      text: z.string().describe("Message text. Supports Markdown."),
    },
    execute: (params, bridge) => bridge("send_message", params),
    frontends: ["teams"],
    tag: "messaging",
  },

  // ── Teams send_message_with_buttons ───────────────────────────────────
  {
    name: "send_message_with_buttons",
    description: `Send a message with clickable link buttons. Buttons appear below the message as Adaptive Card actions.

Example: send_message_with_buttons(text="Choose:", rows=[[{"text":"Docs","url":"https://..."}]])`,
    schema: {
      text: z.string().describe("Message text"),
      rows: z
        .array(
          z.array(
            z.object({
              text: z.string().describe("Button label"),
              url: z.string().optional().describe("URL to open when clicked"),
            }),
          ),
        )
        .describe("Button rows"),
    },
    execute: (params, bridge) => bridge("send_message_with_buttons", params),
    frontends: ["teams"],
    tag: "messaging",
  },

  // ── react ─────────────────────────────────────────────────────────────
  // Reacting is itself a final delivery action — the user sees the emoji
  // appear on their own message, same as receiving a reply. In practice
  // most react calls are acknowledgement-only and end the turn naturally.
  //
  // Soft-terminator design: react is declared `endsTurn: true` so a
  // react-only batch closes the SDK loop cleanly (no separate end_turn()
  // needed, no typing-indicator race). BUT the model can pass
  // `end_turn: false` if it wants to react and keep the turn alive — e.g.
  // "let me look at that 🤔" then a subsequent fetch_url / search /
  // analysis. The PostToolBatch hook honours that param: if every
  // terminator in the batch is a react with `end_turn: false`, the loop
  // continues; if a "real" terminator (end_turn) or a default react is
  // also in the batch, it terminates as usual.
  {
    name: "react",
    description: `Add an emoji reaction to a message. By default this also ends your turn (a reaction is usually a complete acknowledgement — no separate end_turn() needed).

Pass \`end_turn: false\` if you want to react now and keep working on something afterwards (e.g. "🤔" then look something up, then respond). Use this sparingly — most reacts are turn-final.

Valid emoji: 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷 🤷‍♂ 🤷‍♀ 😡`,
    schema: {
      message_id: idSchema.describe("Message ID"),
      emoji: z.string().describe("Reaction emoji"),
      end_turn: z
        .boolean()
        .optional()
        .describe(
          "Whether this reaction ends the turn. Defaults to true (omit). Pass false to keep the turn alive after reacting.",
        ),
      chat_id: chatIdSchema
        .optional()
        .describe(
          "Target chat ID. Omit in chat mode (uses ambient chat). Required from heartbeat mode. Supergroup/channel IDs are negative; user DMs are positive.",
        ),
    },
    // Strip end_turn before bridging — it's a hook-level signal, the
    // backend action handler doesn't need to know about it. chat_id stays
    // in the body; bridge.ts promotes it to the gateway's routing key.
    execute: (params, bridge) => {
      const { end_turn: _endTurn, ...rest } = params;
      return bridge("react", rest);
    },
    frontends: ["telegram"],
    tag: "messaging",
    endsTurn: true,
  },

  // ── edit_message ──────────────────────────────────────────────────────
  {
    name: "edit_message",
    description: "Edit a previously sent message.",
    schema: { message_id: idSchema, text: z.string() },
    execute: (params, bridge) => bridge("edit_message", params),
    frontends: ["telegram"],
    tag: "messaging",
  },

  // ── delete_message ────────────────────────────────────────────────────
  {
    name: "delete_message",
    description: "Delete a message.",
    schema: { message_id: idSchema },
    execute: (params, bridge) => bridge("delete_message", params),
    frontends: ["telegram"],
    tag: "messaging",
  },

  // ── forward_message ───────────────────────────────────────────────────
  {
    name: "forward_message",
    description: "Forward a message within the chat.",
    schema: { message_id: idSchema },
    execute: (params, bridge) => bridge("forward_message", params),
    frontends: ["telegram"],
    tag: "messaging",
  },

  // ── pin_message ───────────────────────────────────────────────────────
  {
    name: "pin_message",
    description: "Pin a message.",
    schema: { message_id: idSchema },
    execute: (params, bridge) => bridge("pin_message", params),
    frontends: ["telegram"],
    tag: "messaging",
  },

  // ── unpin_message ─────────────────────────────────────────────────────
  {
    name: "unpin_message",
    description: "Unpin a message.",
    schema: { message_id: idSchema.optional() },
    execute: (params, bridge) => bridge("unpin_message", params),
    frontends: ["telegram"],
    tag: "messaging",
  },

  // ── stop_poll ─────────────────────────────────────────────────────────
  {
    name: "stop_poll",
    description:
      "Stop an active poll and get the final results. Returns vote counts for each option.",
    schema: {
      message_id: idSchema.describe("Message ID of the poll to stop"),
    },
    execute: (params, bridge) => bridge("stop_poll", params),
    frontends: ["telegram"],
    tag: "messaging",
  },
];
