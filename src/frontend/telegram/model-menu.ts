/**
 * Frontend-agnostic-ish controller for the `/model` UX.
 *
 * Why this module exists
 * ──────────────────────
 *
 * Pre-refactor, `/model` lived directly in `commands.ts` and
 * `callbacks.ts`, each of which read `gateway.backend` — the global
 * chat-role backend. That had two operational consequences once the
 * pool refactor introduced per-chat backend overrides:
 *
 *   1. The picker for a chat that overrode its backend to
 *      `openai-agents` (e.g. an OpenRouter chat in a Claude-default
 *      install) would render Claude's empty OpenRouter catalog
 *      instead of the chat's actual backend catalog.
 *   2. The free-only toggle, gated on `freeCount > 0`, would never
 *      appear because the wrong backend was queried.
 *
 * The fix is to always resolve the per-chat backend via
 * `getBackendForChat(chatId)`. Centralising that logic + the
 * snapshot/menu state assembly here keeps the command/callback
 * handlers thin and gives the rest of Talon one entry point for
 * "give me the data needed to render /model for this chat".
 *
 * Pure-function shape so tests can stub everything; no Telegram or
 * Discord types leak in.
 */

import type { TalonConfig } from "../../util/config.js";
import type { QueryBackend } from "../../core/types.js";
import {
  buildModelMenuState,
  type ModelMenuState,
  type SettingsButton,
} from "./helpers.js";
import {
  hasBackendPool,
  getBackendIdForChat,
  hasChatBackendOverride,
  listAvailableBackends,
  resolveChatBackend,
} from "../../core/backend-controller.js";
import {
  getChatSettings,
  setChatFreeOnly,
} from "../../storage/chat-settings.js";

/**
 * Resolve the backend serving a given chat right now.
 *
 * Thin wrapper around `resolveChatBackend` from the backend
 * controller — same pool-first / gateway-fallback semantics, just
 * shaped for the frontend's `gateway` arg.
 *
 * Returns `null` only when *neither* the pool nor the gateway has a
 * backend wired — `/model` then degrades to "show the active model
 * name only", with no buttons.
 */
export function resolveBackendForChat(
  chatId: string,
  gateway?: { backend: QueryBackend | null },
): QueryBackend | null {
  return resolveChatBackend(chatId, gateway?.backend ?? null);
}

/**
 * Hydrated view ready for rendering the `/model` main menu. Carries
 * the resolved backend so callers can perform follow-up backend
 * operations (resolveModel on a selection, getModelInfo, etc.)
 * against the *same* backend they used to render the menu.
 */
export interface ModelMenuView {
  state: ModelMenuState;
  backend: QueryBackend;
}

/**
 * Build the main-menu view for the given chat. Returns `null` when
 * no backend is currently wired for the chat (e.g. before
 * bootstrap completes) — callers should fall back to a minimal
 * "Model: …" reply.
 *
 * Performs the four pieces of work that need to stay aligned:
 *
 *   1. Resolve the per-chat backend.
 *   2. Read chat-settings (active model, free-only filter).
 *   3. Query the backend for its catalog snapshot.
 *   4. Assemble a `ModelMenuState` with override / free / backend
 *      flags derived from the actual catalog.
 *
 * Errors from the catalog fetch are swallowed inside
 * `buildModelMenuState`'s `.catch` — the menu still renders, just
 * with empty status lines.
 */
export async function buildModelMenuViewForChat(
  chatId: string,
  config: TalonConfig,
  gateway?: { backend: QueryBackend | null },
): Promise<ModelMenuView | null> {
  const backend = resolveBackendForChat(chatId, gateway);
  if (!backend?.getSettingsPresentation) return null;

  const chatSets = getChatSettings(chatId);
  const activeModel = chatSets.model ?? config.model;
  const freeOnly = chatSets.freeOnly === true;

  const availableBackends = listAvailableBackends(config);
  const activeBackendId = hasBackendPool()
    ? getBackendIdForChat(chatId)
    : config.backend;
  const activeBackendEntry = availableBackends.find(
    (b) => b.id === activeBackendId,
  ) ?? {
    id: activeBackendId,
    label: backend.backendLabel ?? activeBackendId,
  };

  const state = await buildModelMenuState({
    chatId,
    activeModel,
    defaultModel: config.model,
    freeOnly,
    fetchSnapshot: async () => {
      const pres = await backend.getSettingsPresentation!(activeModel, {
        callbackPrefix: "model:",
        navCallbackPrefix: "model:nav",
        filter: freeOnly ? "free" : "all",
      });
      return {
        freeCount: pres.freeCount,
        totalCount: pres.totalCount,
        modelDetails: pres.modelDetails,
      };
    },
    fetchActiveDisplay: async () =>
      (await backend.getModelInfo?.(activeModel))?.displayName,
    activeBackend: activeBackendEntry,
    hasBackendOverride: hasBackendPool() && hasChatBackendOverride(chatId),
    showBackendButton: availableBackends.length > 1,
  });

  return { state, backend };
}

/**
 * Result of a `/model` browse-view fetch — the paginated/grouped
 * catalog plus the metadata callers need to render header lines.
 */
export interface ModelBrowseView {
  backend: QueryBackend;
  filter: "all" | "free";
  modelButtons: SettingsButton[];
  page: number;
  totalPages: number;
  freeCount: number;
  totalCount: number;
  view: "models" | "groups";
  provider?: string;
  modelDetails: string[];
  activeDisplay: string;
  activeModel: string;
}

/**
 * Build the browse view (provider groups OR paginated model list)
 * for a chat. The browse view always operates on the chat's current
 * backend — even mid-browse, if the user switched backends in
 * another tab the next browse fetch picks up the new one cleanly.
 */
export async function buildModelBrowseViewForChat(
  chatId: string,
  config: TalonConfig,
  options: {
    filter?: "all" | "free";
    page?: number;
    provider?: string;
  },
  gateway?: { backend: QueryBackend | null },
): Promise<ModelBrowseView | null> {
  const backend = resolveBackendForChat(chatId, gateway);
  if (!backend?.getSettingsPresentation) return null;

  const chatSets = getChatSettings(chatId);
  const activeModel = chatSets.model ?? config.model;
  const freeOnly = chatSets.freeOnly === true;
  const filter: "all" | "free" = options.filter ?? (freeOnly ? "free" : "all");

  const pres = await backend.getSettingsPresentation(activeModel, {
    callbackPrefix: "model:",
    navCallbackPrefix: "model:nav",
    filter,
    ...(options.page !== undefined ? { page: options.page } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
  });

  const modelInfo = await backend.getModelInfo?.(activeModel);
  const activeDisplay = modelInfo?.displayName ?? activeModel;

  return {
    backend,
    filter: pres.filter,
    modelButtons: pres.modelButtons,
    page: pres.page,
    totalPages: pres.totalPages,
    freeCount: pres.freeCount,
    totalCount: pres.totalCount,
    view: pres.view,
    ...(pres.provider !== undefined ? { provider: pres.provider } : {}),
    modelDetails: pres.modelDetails,
    activeDisplay,
    activeModel,
  };
}

/**
 * Hydrated view for the backend submenu — the data needed to render
 * "Backend: …" with the list of switchable backends.
 */
export interface BackendMenuView {
  activeBackend: { id: string; label: string };
  hasBackendOverride: boolean;
  defaultBackendLabel: string;
  available: Array<{ id: string; label: string }>;
}

/**
 * Build the backend-submenu view for a chat. Cheap (no network) —
 * reads the pool state and the config only.
 */
export function buildBackendMenuViewForChat(
  chatId: string,
  config: TalonConfig,
): BackendMenuView {
  const availableBackends = listAvailableBackends(config);
  const activeBackendId = hasBackendPool()
    ? getBackendIdForChat(chatId)
    : config.backend;
  const activeBackend = availableBackends.find(
    (b) => b.id === activeBackendId,
  ) ?? { id: activeBackendId, label: activeBackendId };
  const defaultBackendLabel =
    availableBackends.find((b) => b.id === config.backend)?.label ??
    config.backend;
  return {
    activeBackend,
    hasBackendOverride: hasBackendPool() && hasChatBackendOverride(chatId),
    defaultBackendLabel,
    available: availableBackends,
  };
}

/**
 * Toggle the chat's free-only preference. Returns the new value so
 * the caller can stash it in toast text + the next render.
 */
export function toggleChatFreeOnly(chatId: string): boolean {
  const next = !getChatSettings(chatId).freeOnly;
  setChatFreeOnly(chatId, next ? true : undefined);
  return next;
}
