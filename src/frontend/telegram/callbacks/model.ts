/**
 * `model:*` callbacks — the /model menu controller. Each branch mutates at
 * most one piece of chat-settings (or pool) state and then re-renders one of
 * three views: main menu, backend submenu, or browse.
 *
 * The controller always resolves the *per-chat* backend so the menu reflects
 * active per-chat overrides instead of the global chat-role default.
 */

import type { Context } from "grammy";
import {
  setChatModelForBackend,
  setChatBackend,
} from "../../../storage/chat-settings.js";
import { resolveModelId as resolveModelName } from "../../../core/models/catalog.js";
import { resetSession } from "../../../storage/sessions.js";
import { clearHistory } from "../../../storage/history.js";
import {
  getBackendIdForChat,
  listAvailableBackends,
  rebindChat,
  releaseChat,
} from "../../../core/engine/backend-controller/index.js";
import { resetPulseCheckpoint } from "../../../core/background/pulse.js";
import { escapeHtml } from "../formatting.js";
import {
  renderModelMenuText,
  renderModelMenuKeyboard,
  renderModelBrowseKeyboard,
  renderBackendMenuKeyboard,
  renderBackendMenuText,
} from "../helpers/index.js";
import { parseModelCallback } from "../model-callbacks.js";
import {
  buildModelMenuViewForChat,
  buildModelBrowseViewForChat,
  buildBackendMenuViewForChat,
  resolveBackendForChat,
  toggleChatFreeOnly,
} from "../model-menu.js";
import { resolveActiveModelForChat } from "../../../core/models/active-model.js";
import {
  answerCallbackQuerySafe,
  editOrIgnoreSame,
  type CallbackDeps,
} from "./shared.js";
import { logWarn } from "../../../util/log.js";

/**
 * Run the backend-side half of a chat's session handoff.
 *
 * A backend switch already clears Talon's own stores (session row,
 * history, pulse checkpoint), but those are only half the state.
 * `performSessionReset` also drives the backend capability slots, and
 * the switch path skipped them entirely:
 *
 *   - the OUTGOING backend keeps in-process per-chat state that no
 *     amount of clearing Talon's stores touches. openai-agents holds a
 *     `MemorySession` map keyed by chat id, so switching away and back
 *     resurrected the old conversation the operator meant to drop.
 *   - the INCOMING backend was never warmed, so the first turn after a
 *     switch paid the full cold start — on OpenCode/Kilo that is session
 *     creation plus a per-plugin MCP registration sweep.
 *
 * The warm is deliberately fire-and-forget: it can take seconds, and the
 * callback still has a toast to answer and a menu to redraw. Telegram
 * expires an unanswered callback query, so blocking here would trade a
 * cold first turn for a visibly stuck button.
 */
function handOffBackendSession(
  chatId: string,
  previousBackend: ReturnType<typeof resolveBackendForChat>,
  gateway: CallbackDeps["gateway"],
): void {
  previousBackend?.sessions?.resetChat?.(chatId);
  const nextBackend = resolveBackendForChat(chatId, gateway);
  // Same instance on a no-op switch — warming it again is harmless
  // (every step is idempotent) but pointless, so skip it.
  if (!nextBackend || nextBackend === previousBackend) return;
  void Promise.resolve(nextBackend.sessions?.warmSession?.(chatId)).catch(
    (err) =>
      logWarn(
        "bot",
        `[${chatId}] warm after backend switch failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
  );
}

export async function handleModelCallback(
  ctx: Context,
  data: string,
  cid: string,
  { config, gateway }: CallbackDeps,
): Promise<void> {
  const action = parseModelCallback(data);

  // Acknowledge fast (within Telegram's 30s window) so the user
  // doesn't see a perpetual loading spinner.
  if (action.kind === "done") {
    await answerCallbackQuerySafe(ctx, { text: "Done" });
    try {
      await ctx.deleteMessage();
    } catch {
      /* might lack delete permission */
    }
    return;
  }
  if (action.kind === "noop" || action.kind === "unknown") {
    await answerCallbackQuerySafe(ctx);
    return;
  }

  // State-mutating actions.
  let toast: string | undefined;
  let viewAfter: "menu" | "browse" | "backends" = "menu";
  let browsePage: number | undefined;
  let browseFilter: "all" | "free" | undefined;
  let browseProvider: string | undefined;
  let browseBackToGroups = false;

  if (action.kind === "select") {
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
        return;
      }
      // Persist the pick into the chat's *backend-specific* slot.
      // Switching backends later restores each side's prior choice
      // automatically — the slot isn't shared across backends.
      setChatModelForBackend(cid, beId, resolution.storedValue);
      // Also pin the chat to this backend so a restart doesn't
      // unbind to the role-default and orphan the model id.
      setChatBackend(cid, beId);
      toast = `Model: ${resolution.model.displayName}`;
    } else {
      setChatModelForBackend(cid, beId, resolveModelName(action.modelId));
      setChatBackend(cid, beId);
      const { model: resolved } = await resolveActiveModelForChat(
        cid,
        be,
        beId,
        config,
      );
      toast = `Model: ${resolved ?? "(unset)"}`;
    }
  } else if (action.kind === "reset") {
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
    toast = resolvedDefault
      ? `Model reset to default (${resolvedDefault})`
      : `Model reset — no default available, pick one`;
  } else if (action.kind === "toggle-free") {
    const next = toggleChatFreeOnly(cid);
    toast = `Free only: ${next ? "on" : "off"}`;
  } else if (action.kind === "menu") {
    viewAfter = "menu";
  } else if (action.kind === "browse") {
    viewAfter = "browse";
  } else if (action.kind === "nav-back-to-providers") {
    viewAfter = "browse";
    browseBackToGroups = true;
    browsePage = 1;
  } else if (action.kind === "nav-provider") {
    viewAfter = "browse";
    browseProvider = action.provider;
    browsePage = 1;
  } else if (action.kind === "nav-page") {
    viewAfter = "browse";
    browsePage = action.page;
    browseFilter = action.filter;
    browseProvider = action.provider;
  } else if (action.kind === "nav-filter") {
    // Legacy support — current UX promotes free-toggle on the main
    // menu, but a `model:nav:filter:*` payload from an old message
    // still routes to the browse view with that filter applied.
    viewAfter = "browse";
    browseFilter = action.filter;
    browsePage = 1;
  } else if (action.kind === "backends") {
    viewAfter = "backends";
  } else if (action.kind === "backend-select") {
    // Rebind chat to the chosen backend. Verify the requested id
    // is on the enabled list to keep the menu and the operation
    // in sync — `config.enabledBackends` is a UX filter and we
    // honour it here too.
    const available = listAvailableBackends(config);
    if (!available.some((b) => b.id === action.backendId)) {
      await answerCallbackQuerySafe(ctx, {
        text: "Backend not available",
      });
      return;
    }
    // Resolve the outgoing backend BEFORE rebinding — afterwards this
    // chat already points at the new one and the old in-process state
    // would be unreachable.
    const previousBackend = resolveBackendForChat(cid, gateway);
    const result = await rebindChat(cid, action.backendId, config);
    if (!result.ok) {
      await answerCallbackQuerySafe(ctx, {
        text: result.error?.slice(0, 200) ?? "Rebind failed",
      });
      return;
    }
    setChatBackend(cid, action.backendId);
    // Switching backends drops the previous backend's per-chat
    // session state (it's not portable across backends). We DO
    // NOT clear `modelByBackend` — keeping each backend's prior
    // pick means switching back-and-forth restores each side's
    // last choice automatically (Codex chat keeps gpt-5.5,
    // OpenRouter chat keeps owl-alpha, etc).
    resetSession(cid);
    clearHistory(cid);
    resetPulseCheckpoint(cid);
    handOffBackendSession(cid, previousBackend, gateway);
    const label =
      available.find((b) => b.id === action.backendId)?.label ??
      action.backendId;
    // Toast names the model the new backend will actually run
    // (per-chat slot if remembered, else canonical / operator
    // default; "no default" if catalog-driven with no config).
    const newBackend = resolveBackendForChat(cid, gateway);
    const { model: resolvedNewModel } = await resolveActiveModelForChat(
      cid,
      newBackend,
      action.backendId,
      config,
    );
    toast = resolvedNewModel
      ? `Backend: ${label} (model: ${resolvedNewModel})`
      : `Backend: ${label} — no default model, /model to pick one`;
    viewAfter = "menu";
  } else if (action.kind === "backend-default") {
    // Drop the per-chat backend override; chat reverts to the
    // global chat-role backend. Per-backend model picks are
    // preserved (modelByBackend stays intact) so reverting and
    // switching back later still restores prior choices.
    const previousBackend = resolveBackendForChat(cid, gateway);
    await releaseChat(cid);
    setChatBackend(cid, undefined);
    resetSession(cid);
    clearHistory(cid);
    resetPulseCheckpoint(cid);
    handOffBackendSession(cid, previousBackend, gateway);
    // Resolve the now-default backend's model for the toast.
    const defaultBackend = resolveBackendForChat(cid, gateway);
    const defaultBackendId = getBackendIdForChat(cid);
    const { model: resolvedRoleModel } = await resolveActiveModelForChat(
      cid,
      defaultBackend,
      defaultBackendId,
      config,
    );
    toast = resolvedRoleModel
      ? `Backend reset to default (model: ${resolvedRoleModel})`
      : `Backend reset to default — no model picked, /model to pick one`;
    viewAfter = "menu";
  }

  // Selection / reset / toggle confirmations toast briefly.
  if (toast !== undefined) {
    await answerCallbackQuerySafe(ctx, { text: toast });
  } else {
    await answerCallbackQuerySafe(ctx);
  }

  // Re-render the message in the appropriate view.
  if (viewAfter === "menu") {
    const view = await buildModelMenuViewForChat(cid, config, gateway);
    if (!view) return;
    await editOrIgnoreSame(
      ctx,
      renderModelMenuText(view.state),
      renderModelMenuKeyboard(view.state),
    );
    return;
  }

  if (viewAfter === "backends") {
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
    return;
  }

  // browse view — controller picks the per-chat backend and
  // applies the chat's freeOnly preference when the caller
  // doesn't override the filter explicitly. `browseBackToGroups`
  // means "drop any cached provider drill" so we omit `provider`.
  const browse = await buildModelBrowseViewForChat(
    cid,
    config,
    {
      ...(browseFilter !== undefined ? { filter: browseFilter } : {}),
      ...(browsePage !== undefined ? { page: browsePage } : {}),
      ...(browseProvider !== undefined && !browseBackToGroups
        ? { provider: browseProvider }
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
