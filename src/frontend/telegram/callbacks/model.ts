/**
 * `model:*` callbacks — the /model menu controller. Each handler mutates at
 * most one piece of chat-settings (or pool) state, then the router
 * re-renders one of three views: main menu, backend submenu, or browse.
 *
 * The controller always resolves the *per-chat* backend so the menu reflects
 * active per-chat overrides instead of the global chat-role default.
 *
 * Callback data is parsed by `parseModelCallback` (model-callbacks.ts); the
 * table below maps each parsed `kind` to its handler in `model/`:
 *   - `control` — done / noop / unknown (ack only)
 *   - `select`  — select / reset / toggle-free
 *   - `nav`     — menu / browse / nav-* / backends (view changes only)
 *   - `backend` — backend-select / backend-default (rebind + handoff)
 *   - `views`   — the three renderers
 */

import type { Context } from "grammy";
import { parseModelCallback } from "../model-callbacks.js";
import { answerCallbackQuerySafe, type CallbackDeps } from "./query.js";
import { handleDone, handleNoop } from "./model/control.js";
import { handleSelect, handleReset, handleToggleFree } from "./model/select.js";
import {
  showMenu,
  showBrowse,
  navBackToProviders,
  navProvider,
  navPage,
  navFilter,
  showBackends,
} from "./model/nav.js";
import { handleBackendSelect, handleBackendDefault } from "./model/backend.js";
import { renderModelView } from "./model/views.js";
import type {
  ModelCallbackHandler,
  ModelCallbackHandlers,
} from "./model/types.js";

// Null-prototype so a parsed kind can never resolve an inherited
// Object.prototype method via `handlers[kind]`.
export const MODEL_CALLBACK_HANDLERS: ModelCallbackHandlers = Object.assign(
  Object.create(null),
  {
    done: handleDone,
    noop: handleNoop,
    unknown: handleNoop,
    select: handleSelect,
    reset: handleReset,
    "toggle-free": handleToggleFree,
    menu: showMenu,
    browse: showBrowse,
    "nav-back-to-providers": navBackToProviders,
    "nav-provider": navProvider,
    "nav-page": navPage,
    "nav-filter": navFilter,
    backends: showBackends,
    "backend-select": handleBackendSelect,
    "backend-default": handleBackendDefault,
  } satisfies ModelCallbackHandlers,
);

export async function handleModelCallback(
  ctx: Context,
  data: string,
  cid: string,
  deps: CallbackDeps,
): Promise<void> {
  const action = parseModelCallback(data);
  // Every parsed kind has a handler; the cast only widens the parameter
  // type so the union action can be passed through.
  const handler = MODEL_CALLBACK_HANDLERS[action.kind] as
    ModelCallbackHandler | undefined;
  if (!handler) {
    await answerCallbackQuerySafe(ctx);
    return;
  }
  const outcome = await handler(ctx, action, cid, deps);
  if (!outcome) return;

  // Selection / reset / toggle confirmations toast briefly.
  if (outcome.toast !== undefined) {
    await answerCallbackQuerySafe(ctx, { text: outcome.toast });
  } else {
    await answerCallbackQuerySafe(ctx);
  }

  // Re-render the message in the appropriate view.
  await renderModelView(ctx, outcome.view, cid, deps);
}
