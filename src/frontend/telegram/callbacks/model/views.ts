/**
 * Re-render the /model message in one of its three views: main menu,
 * backend submenu, or browse.
 */

import type { Context } from "grammy";
import { escapeHtml } from "../../formatting.js";
import {
  renderModelMenuText,
  renderModelMenuKeyboard,
  renderModelBrowseKeyboard,
  renderBackendMenuKeyboard,
  renderBackendMenuText,
} from "../../render/menu.js";
import {
  buildModelMenuViewForChat,
  buildModelBrowseViewForChat,
  buildBackendMenuViewForChat,
} from "../../model-menu.js";
import { editOrIgnoreSame, type CallbackDeps } from "../query.js";
import type { ModelView } from "./types.js";

export async function renderModelView(
  ctx: Context,
  view: ModelView,
  cid: string,
  deps: CallbackDeps,
): Promise<void> {
  if (view.kind === "menu") return renderMenu(ctx, cid, deps);
  if (view.kind === "backends") return renderBackends(ctx, cid, deps);
  return renderBrowse(ctx, view, cid, deps);
}

async function renderMenu(
  ctx: Context,
  cid: string,
  { config, gateway }: CallbackDeps,
): Promise<void> {
  const view = await buildModelMenuViewForChat(cid, config, gateway);
  if (!view) return;
  await editOrIgnoreSame(
    ctx,
    renderModelMenuText(view.state),
    renderModelMenuKeyboard(view.state),
  );
}

async function renderBackends(
  ctx: Context,
  cid: string,
  { config }: CallbackDeps,
): Promise<void> {
  const menu = buildBackendMenuViewForChat(cid, config);
  await editOrIgnoreSame(
    ctx,
    renderBackendMenuText({
      activeBackend: menu.activeBackend,
      hasBackendOverride: menu.hasBackendOverride,
      defaultBackendLabel: menu.defaultBackendLabel,
    }),
    renderBackendMenuKeyboard({
      available: menu.available,
      activeBackendId: menu.activeBackend.id,
      hasBackendOverride: menu.hasBackendOverride,
    }),
  );
}

// browse view — controller picks the per-chat backend and
// applies the chat's freeOnly preference when the caller
// doesn't override the filter explicitly. `backToGroups`
// means "drop any cached provider drill" so we omit `provider`.
async function renderBrowse(
  ctx: Context,
  view: Extract<ModelView, { kind: "browse" }>,
  cid: string,
  { config, gateway }: CallbackDeps,
): Promise<void> {
  const browse = await buildModelBrowseViewForChat(
    cid,
    config,
    {
      ...(view.filter !== undefined ? { filter: view.filter } : {}),
      ...(view.page !== undefined ? { page: view.page } : {}),
      ...(view.provider !== undefined && !view.backToGroups
        ? { provider: view.provider }
        : {}),
    },
    gateway,
  );
  if (!browse) return;
  const lines = [
    `<b>Model:</b> <code>${escapeHtml(browse.activeDisplay)}</code>`,
    ...browse.modelDetails.map(escapeHtml),
    ...(browse.filter === "free" && browse.freeCount > 0
      ? ["<i>Filter: free-tier only.</i>"]
      : []),
  ];
  await editOrIgnoreSame(
    ctx,
    lines.join("\n"),
    renderModelBrowseKeyboard(
      browse.modelButtons,
      {
        page: browse.page,
        totalPages: browse.totalPages,
        filter: browse.filter,
        freeCount: browse.freeCount,
        totalCount: browse.totalCount,
      },
      browse.view,
      browse.provider,
      "model:menu",
    ),
  );
}
