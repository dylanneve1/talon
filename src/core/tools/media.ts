/**
 * Media tools — list recent media in a chat.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const mediaTools: ToolDefinition[] = [
  {
    name: "list_media",
    description:
      "List recent photos, documents, and other media in the current chat with file paths. Use this to find a previously sent photo or file to re-read or reference.",
    schema: {
      limit: z
        .number()
        .optional()
        .describe("Number of entries (default 10, max 20)"),
    },
    execute: (params, bridge) =>
      bridge("list_media", { limit: params.limit }),
    frontends: ["telegram"],
    tag: "media",
  },
];
