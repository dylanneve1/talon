/**
 * Model / backend discovery tools.
 *
 * These let the model see what it's running on: the selectable models on a
 * backend and the list of available backends. The main use is picking a valid
 * `model` id for a per-trigger / per-cron model override — those overrides are
 * restricted to THIS chat's current backend (so the wake-up can resume the
 * session), which is exactly what `list_models` (no argument) returns.
 */

import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const modelTools: ToolDefinition[] = [
  {
    name: "list_models",
    description:
      "List the selectable models on a backend. With no argument, lists the models on THIS chat's current backend — the only backend whose models a per-trigger `model` override can use so the session resumes with continuity. For create_cron_job, use this with no backend to pick a same-provider model, or pass `backend` to inspect a provider you will also set via `provider`. Any registered backend can be listed: it is booted on-demand to read its catalog, so it need not be currently active.",
    schema: {
      backend: z
        .string()
        .optional()
        .describe(
          "Backend id to list models for (e.g. 'claude'). Defaults to this chat's current backend. Call list_backends to see valid ids.",
        ),
    },
    execute: (params, bridge) => bridge("list_models", params),
    tag: "models",
  },

  {
    name: "plan_usage",
    description:
      "Read usage and headroom for EVERY configured backend, not just this chat's: how much of each subscription's rate-limit windows is spent, when they reset, and one comparable headroom figure per backend. A backend with no usage API reports headroom from Talon's own local token ledger against its configured budget (marked 'local budget'), and one with neither says so. Use it before starting long or expensive work, when deciding whether to defer something, or to see which backend background work will be routed to.",
    schema: {},
    execute: (_params, bridge) => bridge("plan_usage", {}),
    tag: "models",
  },

  {
    name: "list_backends",
    description:
      "List the available backends (providers), which one this chat is currently using, and how much plan headroom each has left. Useful for understanding the model/provider landscape and for seeing where unpinned background work (sub-agents, cron query jobs, the heartbeat) will be routed. Note: a per-job `model` override must stay on this chat's current backend, so use list_models (no argument) to pick a model for a trigger or cron job.",
    schema: {},
    execute: (_params, bridge) => bridge("list_backends", {}),
    tag: "models",
  },
];
