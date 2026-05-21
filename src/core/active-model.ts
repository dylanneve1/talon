/**
 * Active-model resolution for a chat.
 *
 * Why this module exists
 * ──────────────────────
 *
 * Per-chat backend overrides and per-chat model overrides are stored
 * independently in `chat-settings.ts`. That decoupling is correct —
 * model and backend are orthogonal axes — but the read-side fallback
 * pattern that grew up around it (`chatSets.model ?? config.model`)
 * has a soft assumption that the override is always coherent with
 * the chat's active backend. Two recurring bug classes break that
 * assumption:
 *
 *   1. **Reset-on-non-default-backend** (2026-05-21 Dylan): chat is
 *      bound to Codex, user hits "Reset" in `/model`, code clears
 *      the override, the read side falls through to `config.model =
 *      "claude-opus-4-7"`. Display + downstream query both treat the
 *      Codex chat as having an Opus model.
 *
 *   2. **Cross-backend orphan** (2026-05-19): a chat stores a model
 *      id that's only valid in backend X, but the chat's bound
 *      backend got changed (or restarted on a different role-default)
 *      and is now backend Y. The stored override is honored without
 *      validation — Y rejects it on every turn.
 *
 * The fix here is one helper, two cases:
 *
 *   - If the chat has a stored model override, validate it against
 *     the active backend's catalog via `backend.resolveModel(query)`.
 *     Honor it only on `kind === "exact"` with a selectable model.
 *
 *   - Otherwise (no override, or override didn't validate), ask the
 *     active backend for its own default via `backend.getDefaultModel()`.
 *     Fall through to `config.model` only when the backend can't
 *     supply one — preserves the existing semantics for the global
 *     chat-role default path.
 *
 * Every callback that displays or mutates the active model should
 * route through this helper so display, persisted state, and
 * downstream query stay coherent.
 */

import { getChatSettings } from "../storage/chat-settings.js";
import type { QueryBackend } from "./types.js";
import type { TalonConfig } from "../util/config.js";
import { logWarn } from "../util/log.js";

/**
 * Reasons `resolveActiveModelForChat` chose its returned id. Surfaced
 * mainly for tests and for toast wording — callers can use this to
 * tell the user "Model: X (default)" vs "Model: X (override)".
 */
export type ActiveModelSource =
  | "override-valid"
  | "override-invalid-fallback"
  | "backend-default"
  | "config-default";

export interface ActiveModelResolution {
  model: string;
  source: ActiveModelSource;
}

/**
 * Resolve the model a chat should use right now, validating against
 * the active backend.
 *
 * - `backend` is typically the per-chat backend from `resolveChatBackend()`.
 *   Pass `null` to skip validation (degrades to `override ?? config.model`).
 */
export async function resolveActiveModelForChat(
  chatId: string,
  backend: QueryBackend | null,
  config: TalonConfig,
): Promise<ActiveModelResolution> {
  const chatSets = getChatSettings(chatId);

  // Stored per-chat override path — validate against the active
  // backend's catalog when possible.
  if (chatSets.model) {
    if (!backend?.resolveModel) {
      // No resolver — trust the stored value. This is the legacy
      // behavior for backends that don't expose a model catalog.
      return { model: chatSets.model, source: "override-valid" };
    }
    try {
      const resolution = await backend.resolveModel(chatSets.model);
      if (resolution.kind === "exact" && resolution.model.selectable) {
        return { model: chatSets.model, source: "override-valid" };
      }
      logWarn(
        "settings",
        `Per-chat model override ${chatSets.model} is not valid for the ` +
          `active backend (${backend.backendLabel ?? "unknown"}). Falling ` +
          `back to backend default.`,
      );
    } catch (err) {
      logWarn(
        "settings",
        `resolveModel threw while validating override ${chatSets.model}: ` +
          `${err instanceof Error ? err.message : String(err)}. Falling back ` +
          `to backend default.`,
      );
    }
    // Fall through to backend-default branch with the
    // "override-invalid-fallback" source so the caller can decide
    // whether to clear the stale override.
    const def = await safeBackendDefault(backend);
    if (def) return { model: def, source: "override-invalid-fallback" };
    return { model: config.model, source: "override-invalid-fallback" };
  }

  // No override — ask the backend for its default.
  if (backend?.getDefaultModel) {
    const def = await safeBackendDefault(backend);
    if (def) return { model: def, source: "backend-default" };
  }
  return { model: config.model, source: "config-default" };
}

async function safeBackendDefault(
  backend: QueryBackend,
): Promise<string | null> {
  if (!backend.getDefaultModel) return null;
  try {
    const v = await backend.getDefaultModel();
    if (typeof v === "string" && v.length > 0) return v;
    return null;
  } catch (err) {
    logWarn(
      "settings",
      `backend.getDefaultModel threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Convenience: same as `resolveActiveModelForChat` but returns the
 * model id directly. Use when you don't care about the source tag.
 */
export async function getActiveModelForChat(
  chatId: string,
  backend: QueryBackend | null,
  config: TalonConfig,
): Promise<string> {
  const { model } = await resolveActiveModelForChat(chatId, backend, config);
  return model;
}
