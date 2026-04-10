/**
 * Chat info tools — metadata, admins, settings.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const chatTools: ToolDefinition[] = [
  {
    name: "get_chat_info",
    description: "Get chat title, type, member count.",
    schema: {},
    execute: (_params, bridge) => bridge("get_chat_info", {}),
    tag: "chat",
  },

  {
    name: "get_chat_admins",
    description: "List chat administrators.",
    schema: {},
    execute: (_params, bridge) => bridge("get_chat_admins", {}),
    frontends: ["telegram"],
    tag: "chat",
  },

  {
    name: "get_chat_member_count",
    description: "Get total member count.",
    schema: {},
    execute: (_params, bridge) => bridge("get_chat_member_count", {}),
    frontends: ["telegram"],
    tag: "chat",
  },

  {
    name: "set_chat_title",
    description: "Change chat title (admin).",
    schema: { title: z.string() },
    execute: (params, bridge) => bridge("set_chat_title", params),
    frontends: ["telegram"],
    tag: "chat",
  },

  {
    name: "set_chat_description",
    description: "Change chat description (admin).",
    schema: { description: z.string() },
    execute: (params, bridge) => bridge("set_chat_description", params),
    frontends: ["telegram"],
    tag: "chat",
  },
];
