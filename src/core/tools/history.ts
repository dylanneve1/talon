/**
 * Chat history tools — read, search, get messages, download media.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const historyTools: ToolDefinition[] = [
  {
    name: "read_chat_history",
    description:
      "Read messages from the chat. Use 'before' to go back in time (e.g. '2026-03-13').",
    schema: {
      limit: z
        .number()
        .optional()
        .describe("Number of messages (default 30, max 100)"),
      before: z
        .string()
        .optional()
        .describe("Fetch messages before this date (ISO format)"),
      offset_id: z.number().optional().describe("Fetch before this message ID"),
    },
    execute: (params, bridge) =>
      bridge("read_history", {
        limit: params.limit ?? 30,
        before: params.before,
        offset_id: params.offset_id,
      }),
    frontends: ["telegram"],
    tag: "history",
  },

  {
    name: "search_chat_history",
    description: "Search messages by keyword.",
    schema: {
      query: z.string(),
      limit: z.number().optional(),
    },
    execute: (params, bridge) => bridge("search_history", params),
    frontends: ["telegram"],
    tag: "history",
  },

  {
    name: "get_user_messages",
    description: "Get messages from a specific user.",
    schema: {
      user_name: z.string(),
      limit: z.number().optional(),
    },
    execute: (params, bridge) => bridge("get_user_messages", params),
    frontends: ["telegram"],
    tag: "history",
  },

  {
    name: "get_message_by_id",
    description: "Get a specific message by ID.",
    schema: { message_id: z.number() },
    execute: (params, bridge) => bridge("get_message_by_id", params),
    frontends: ["telegram"],
    tag: "history",
  },

  {
    name: "download_media",
    description:
      "Download a photo, document, or other media from a message by its ID. Saves the file to the workspace and returns the file path so you can read/analyze it. Use this when you see a [photo] or [document] in chat history but don't have the file.",
    schema: {
      message_id: z
        .number()
        .describe("Message ID containing the media to download"),
    },
    execute: (params, bridge) => bridge("download_media", params),
    frontends: ["telegram"],
    tag: "history",
  },
];
