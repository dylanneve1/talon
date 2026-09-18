/**
 * Model selection — `model:<id>`, `model:reset`, `model:toggle-free`.
 *
 * Every branch resolves the *per-chat* backend so the pick is validated
 * against, and stored under, the backend the chat actually runs on.
 */

import type { Context } from "grammy";
import {
  setChatModelForBackend,
  setChatBackend,
} from "../../../../storage/chat-settings.js";
import { resolveModelId as resolveModelName } from "../../../../core/models/catalog.js";
import { getBackendIdForChat } from "../../../../core/engine/backend-controller/index.js";
import { resolveActiveModelForChat } from "../../../../core/models/active-model.js";
import type { ModelCallback } from "../../model-callbacks.js";
import { resolveBackendForChat, toggleChatFreeOnly } from "../../model-menu.js";
import { answerCallbackQuerySafe, type CallbackDeps } from "../query.js";
import type { ModelOutcome } from "./types.js";

export async function handleSelect(
  ctx: Context,
  action: Extract<ModelCallback, { kind: "select" }>,
  cid: string,
  { config, gateway }: CallbackDeps,
): Promise<ModelOutcome | undefined> {
  // Resolve selection against the *per-chat* backend — if the
  // chat has switched to openai-agents we must validate the id
  // against that catalog, not the global default's.
  const be = resolveBackendForChat(cid, gateway);
  const beId = getBackendIdForChat(cid);
  if (be?.models?.resolveModelInfo) {
    const resolution = await be.models?.resolveModelInfo(action.modelId);
    if (resolution.kind !== "exact" || !resolution.model.selectable) {
      await answerCallbackQuerySafe(ctx, {
        text:
          resolution.kind === "exact"
            ? (resolution.model.unavailableReason ?? "Unavailable")
            : "Model is unavailable",
      });
      return undefined;
    }
    // Persist the pick into the chat's *backend-specific* slot.
    // Switching backends later restores each side's prior choice
    // automatically — the slot isn't shared across backends.
    setChatModelForBackend(cid, beId, resolution.storedValue);
    // Also pin the chat to this backend so a restart doesn't
    // unbind to the role-default and orphan the model id.
    setChatBackend(cid, beId);
    return {
      toast: `Model: ${resolution.model.displayName}`,
      view: { kind: "menu" },
    };
  }
  setChatModelForBackend(cid, beId, resolveModelName(action.modelId));
  setChatBackend(cid, beId);
  const { model: resolved } = await resolveActiveModelForChat(
    cid,
    be,
    beId,
    config,
  );
  return { toast: `Model: ${resolved ?? "(unset)"}`, view: { kind: "menu" } };
}

export async function handleReset(
  _ctx: Context,
  _action: Extract<ModelCallback, { kind: "reset" }>,
  cid: string,
  { config, gateway }: CallbackDeps,
): Promise<ModelOutcome> {
  // Clear this backend's slot only — other backends' picks stay.
  // Compute the toast through the resolver so the label names the
  // backend's actual default (or "No model selected" when there
  // isn't one — catalog-driven backend, no operator config).
  const be = resolveBackendForChat(cid, gateway);
  const beId = getBackendIdForChat(cid);
  setChatModelForBackend(cid, beId, undefined);
  const { model: resolvedDefault } = await resolveActiveModelForChat(
    cid,
    be,
    beId,
    config,
  );
  return {
    toast: resolvedDefault
      ? `Model reset to default (${resolvedDefault})`
      : `Model reset — no default available, pick one`,
    view: { kind: "menu" },
  };
}

export async function handleToggleFree(
  _ctx: Context,
  _action: Extract<ModelCallback, { kind: "toggle-free" }>,
  cid: string,
): Promise<ModelOutcome> {
  const next = toggleChatFreeOnly(cid);
  return { toast: `Free only: ${next ? "on" : "off"}`, view: { kind: "menu" } };
}
