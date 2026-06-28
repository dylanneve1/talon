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
import type { ToolDefinition } from "./types.js";

export const modelTools: ToolDefinition[] = [
  {
    name: "list_models",
    description:
      "List the selectable models on a backend. With no argument, lists the models on THIS chat's current backend — the only backend whose models a per-trigger/per-cron `model` override can use (overrides stay on the chat's backend so the session resumes with continuity). Use this to pick a valid model id before setting `model` on trigger_create or create_cron_job. Optionally pass `backend` to inspect any registered backend's models for awareness — the backend is booted on-demand to read its catalog, so it need not be the currently-active one.",
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
    name: "list_backends",
    description:
      "List the available backends (providers) and which one this chat is currently using. Useful for understanding the model/provider landscape. Note: a per-job `model` override must stay on this chat's current backend, so use list_models (no argument) to pick a model for a trigger or cron job.",
    schema: {},
    execute: (_params, bridge) => bridge("list_backends", {}),
    tag: "models",
  },
];
