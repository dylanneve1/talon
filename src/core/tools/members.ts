/**
 * Member tools — list members, user info, online count, pinned messages.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const memberTools: ToolDefinition[] = [
  {
    name: "list_chat_members",
    description: "List chat members with names, IDs, online status, badges.",
    schema: { limit: z.number().optional() },
    execute: (params, bridge) =>
      bridge("list_known_users", { limit: params.limit }),
    frontends: ["telegram"],
    tag: "members",
  },

  {
    name: "get_member_info",
    description: "Get detailed info about a user by ID.",
    schema: { user_id: z.number() },
    execute: (params, bridge) => bridge("get_member_info", params),
    frontends: ["telegram"],
    tag: "members",
  },

  {
    name: "online_count",
    description:
      "Get how many members are currently online or recently active.",
    schema: {},
    execute: (_params, bridge) => bridge("online_count", {}),
    frontends: ["telegram"],
    tag: "members",
  },

  {
    name: "get_pinned_messages",
    description: "Get all pinned messages in the current chat.",
    schema: {},
    execute: (_params, bridge) => bridge("get_pinned_messages", {}),
    frontends: ["telegram"],
    tag: "members",
  },
];
