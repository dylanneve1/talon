/**
 * Sticker tools — browse, download, save, create, and manage sticker packs.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const stickerTools: ToolDefinition[] = [
  {
    name: "get_sticker_pack",
    description:
      "Get all stickers in a sticker pack by its name. Returns emoji + file_id for each sticker so you can send them. Use when you see a sticker set name in chat history.",
    schema: {
      set_name: z
        .string()
        .describe(
          "Sticker set name (e.g. 'AnimatedEmojies' or from sticker metadata)",
        ),
    },
    execute: (params, bridge) => bridge("get_sticker_pack", params),
    frontends: ["telegram"],
    tag: "stickers",
  },

  {
    name: "download_sticker",
    description:
      "Download a sticker image to workspace so you can view its contents. Returns the file path.",
    schema: {
      file_id: z
        .string()
        .describe("Sticker file_id from chat history or sticker pack listing"),
    },
    execute: (params, bridge) => bridge("download_sticker", params),
    frontends: ["telegram"],
    tag: "stickers",
  },

  {
    name: "save_sticker_pack",
    description:
      "Save a sticker pack's file_ids to workspace for quick reuse. Once saved, you can read the JSON file to find stickers by emoji and send them instantly.",
    schema: {
      set_name: z.string().describe("Sticker set name"),
    },
    execute: (params, bridge) => bridge("save_sticker_pack", params),
    frontends: ["telegram"],
    tag: "stickers",
  },

  {
    name: "create_sticker_set",
    description: `Create a new sticker pack owned by a user. The bot will be the creator.
Sticker images must be PNG/WEBP, max 512x512px for static stickers.
The set name will automatically get "_by_<botname>" appended if needed.

Example: create_sticker_set(user_id=123, name="cool_pack", title="Cool Stickers", file_path="/path/to/sticker.png", emoji_list=["😎"])`,
    schema: {
      user_id: z.number().describe("Telegram user ID who will own the pack"),
      name: z
        .string()
        .describe(
          "Short name for the pack (a-z, 0-9, underscores). Will get _by_<botname> appended.",
        ),
      title: z.string().describe("Display title for the pack (1-64 chars)"),
      file_path: z
        .string()
        .describe("Path to the sticker image file (PNG/WEBP, 512x512 max)"),
      emoji_list: z
        .array(z.string())
        .optional()
        .describe("Emojis for this sticker (default: ['🎨'])"),
      format: z
        .enum(["static", "animated", "video"])
        .optional()
        .describe("Sticker format (default: static)"),
    },
    execute: (params, bridge) => bridge("create_sticker_set", params),
    frontends: ["telegram"],
    tag: "stickers",
  },

  {
    name: "add_sticker_to_set",
    description:
      "Add a new sticker to an existing sticker pack created by the bot.",
    schema: {
      user_id: z.number().describe("Telegram user ID who owns the pack"),
      name: z.string().describe("Sticker set name (including _by_<botname>)"),
      file_path: z.string().describe("Path to the sticker image file"),
      emoji_list: z
        .array(z.string())
        .optional()
        .describe("Emojis for this sticker (default: ['🎨'])"),
      format: z
        .enum(["static", "animated", "video"])
        .optional()
        .describe("Sticker format (default: static)"),
    },
    execute: (params, bridge) => bridge("add_sticker_to_set", params),
    frontends: ["telegram"],
    tag: "stickers",
  },

  {
    name: "delete_sticker_from_set",
    description: "Remove a specific sticker from a pack by its file_id.",
    schema: {
      sticker_file_id: z
        .string()
        .describe(
          "file_id of the sticker to remove (get from get_sticker_pack)",
        ),
    },
    execute: (params, bridge) => bridge("delete_sticker_from_set", params),
    frontends: ["telegram"],
    tag: "stickers",
  },

  {
    name: "set_sticker_set_title",
    description: "Change the title of a sticker pack created by the bot.",
    schema: {
      name: z.string().describe("Sticker set name"),
      title: z.string().describe("New title (1-64 chars)"),
    },
    execute: (params, bridge) => bridge("set_sticker_set_title", params),
    frontends: ["telegram"],
    tag: "stickers",
  },

  {
    name: "delete_sticker_set",
    description:
      "Permanently delete an entire sticker pack created by the bot.",
    schema: {
      name: z.string().describe("Sticker set name to delete"),
    },
    execute: (params, bridge) => bridge("delete_sticker_set", params),
    frontends: ["telegram"],
    tag: "stickers",
  },
];
