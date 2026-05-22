/**
 * All callback_query handlers (settings panel, model/effort selectors, proactive toggle).
 */

import type { Bot, Context } from "grammy";
import type { TalonConfig } from "../../util/config.js";
import { logWarn } from "../../util/log.js";
import {
  getChatSettings,
  setChatModel,
  setChatModelForBackend,
  setChatBackend,
  setChatEffort,
  clearAllChatModels,
  resolveModelName,
  EFFORT_LEVELS,
  type EffortLevel,
} from "../../storage/chat-settings.js";
import { resetSession } from "../../storage/sessions.js";
import { clearHistory } from "../../storage/history.js";
import {
  getBackendIdForChat,
  listAvailableBackends,
  rebindChat,
  releaseChat,
} from "../../core/backend-controller.js";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
  resetPulseCheckpoint,
} from "../../core/pulse.js";
import { handleCallbackQuery } from "./handlers.js";
import { escapeHtml } from "./formatting.js";
import {
  renderSettingsText,
  renderSettingsKeyboard,
  renderModelMenuText,
  renderModelMenuKeyboard,
  renderModelBrowseKeyboard,
  renderBackendMenuKeyboard,
  renderBackendMenuText,
  type SettingsButton,
} from "./helpers.js";
import { parseModelCallback } from "./model-callbacks.js";
import {
  buildModelMenuViewForChat,
  buildModelBrowseViewForChat,
  buildBackendMenuViewForChat,
  resolveBackendForChat,
  toggleChatFreeOnly,
} from "./model-menu.js";
import { resolveActiveModelForChat } from "../../core/active-model.js";

/**
 * Wrapper around `editMessageText` that swallows Telegram's
 * "message is not modified" noise (we hit it whenever a user
 * taps a button that doesn't actually change the rendered state)
 * while still surfacing real failures to the operator log. Without
 * this distinction, buttons silently fail to update and the symptom
 * is "I clicked X and nothing happened".
 */
async function editOrIgnoreSame(
  ctx: Context,
  text: string,
  inlineKeyboard: Array<Array<SettingsButton>>,
): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/message is not modified/i.test(msg)) return;
    logWarn("bot", `editMessageText failed: ${msg}`);
  }
}

export function registerCallbacks(
  bot: Bot,
  config: TalonConfig,
  gateway?: { backend: import("../../core/types.js").QueryBackend | null },
): void {
  // ── Callback query handler ──────────────────────────────────────────────────

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const cid = String(ctx.chat?.id ?? ctx.from.id);

    // Handle /settings callbacks (effort, pulse, done). Model selection
    // is intentionally NOT here — that lives entirely under /model now.
    // Legacy `settings:model:*` and `settings:models:*` callbacks from
    // old messages are silently dismissed so stale buttons don't fire
    // the model dispatcher path.
    if (data.startsWith("settings:")) {
      const parts = data.split(":");
      if (!parts[1]) {
        await ctx.answerCallbackQuery({ text: "Invalid callback data" });
        return;
      }
      const category = parts[1];
      const value = parts[2] ?? "";

      if (category === "noop") {
        await ctx.answerCallbackQuery();
        return;
      }

      // Stale `settings:done` payloads from older bot versions that
      // shipped a Done button. Quietly ack — the user can dismiss the
      // message via Telegram's UI now.
      if (category === "done") {
        await ctx.answerCallbackQuery();
        return;
      }

      // Stale model-picker callbacks (`settings:model:*`, `settings:models:*`)
      // emitted by older Talon builds. Quietly ack — the user can re-open
      // /model to get the current picker.
      if (category === "model" || category === "models") {
        await ctx.answerCallbackQuery({
          text: "Picker moved — use /model",
        });
        return;
      }

      if (category === "effort") {
        if (value === "adaptive") {
          setChatEffort(cid, undefined);
        } else if (EFFORT_LEVELS.includes(value as EffortLevel)) {
          setChatEffort(cid, value as EffortLevel);
        }
        await ctx.answerCallbackQuery({
          text: `Effort: ${getChatSettings(cid).effort ?? "adaptive"}`,
        });
      } else if (category === "proactive") {
        if (value === "on") {
          enablePulse(cid);
          registerChat(cid);
        } else {
          disablePulse(cid);
        }
        await ctx.answerCallbackQuery({ text: `Pulse: ${value}` });
      }

      const chatSets = getChatSettings(cid);
      const settingsBe = resolveBackendForChat(cid, gateway);
      const settingsBeId = getBackendIdForChat(cid);
      const { model: resolvedSettingsModel } = await resolveActiveModelForChat(
        cid,
        settingsBe,
        settingsBeId,
        config,
      );
      const activeModel = resolvedSettingsModel ?? "No model selected";
      const effortName = chatSets.effort ?? "adaptive";
      const pulseOn = isPulseEnabled(cid);

      try {
        await ctx.editMessageText(
          renderSettingsText(
            activeModel,
            effortName,
            pulseOn,
            chatSets.pulseIntervalMs,
          ),
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: renderSettingsKeyboard(
                activeModel,
                effortName,
                pulseOn,
              ),
            },
          },
        );
      } catch {
        /* message unchanged */
      }
      return;
    }

    // Handle pulse callbacks
    if (data.startsWith("pulse:")) {
      const val = data.slice(6);
      if (val === "on") {
        enablePulse(cid);
        registerChat(cid);
        await ctx.answerCallbackQuery({ text: "Pulse: on" });
      } else if (val === "off") {
        disablePulse(cid);
        await ctx.answerCallbackQuery({ text: "Pulse: off" });
      }
      const enabled = isPulseEnabled(cid);
      try {
        await ctx.editMessageText(
          `<b>🔔 Pulse:</b> ${enabled ? "on" : "off"}\n\nReads along every few minutes and jumps in when there's something to add.`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: enabled ? "✓ On" : "On", callback_data: "pulse:on" },
                  {
                    text: !enabled ? "✓ Off" : "Off",
                    callback_data: "pulse:off",
                  },
                ],
              ],
            },
          },
        );
      } catch {
        /* unchanged */
      }
      return;
    }

    // Handle effort callbacks
    if (data.startsWith("effort:")) {
      const level = data.slice(7);
      if (level === "adaptive") {
        setChatEffort(cid, undefined);
        await ctx.answerCallbackQuery({ text: "Effort: adaptive" });
      } else if (EFFORT_LEVELS.includes(level as EffortLevel)) {
        setChatEffort(cid, level as EffortLevel);
        await ctx.answerCallbackQuery({ text: `Effort: ${level}` });
      }
      const current = getChatSettings(cid).effort ?? "adaptive";
      try {
        await ctx.editMessageText(`<b>Effort:</b> ${current}`, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: current === "off" ? "\u2713 Off" : "Off",
                  callback_data: "effort:off",
                },
                {
                  text: current === "low" ? "\u2713 Low" : "Low",
                  callback_data: "effort:low",
                },
                {
                  text: current === "medium" ? "\u2713 Med" : "Med",
                  callback_data: "effort:medium",
                },
              ],
              [
                {
                  text: current === "high" ? "\u2713 High" : "High",
                  callback_data: "effort:high",
                },
                {
                  text: current === "max" ? "\u2713 Max" : "Max",
                  callback_data: "effort:max",
                },
                {
                  text: current === "adaptive" ? "\u2713 Auto" : "Auto",
                  callback_data: "effort:adaptive",
                },
              ],
            ],
          },
        });
      } catch {
        /* message unchanged */
      }
      return;
    }

    // Handle /model callbacks via the pure parser. Each branch
    // mutates at most one piece of chat-settings (or pool) state and
    // then re-renders one of three views — main menu, backend
    // submenu, or browse — via the `model-menu` controller. The
    // controller always resolves the *per-chat* backend so the menu
    // reflects active per-chat overrides instead of the global
    // chat-role default.
    if (data.startsWith("model:")) {
      const action = parseModelCallback(data);

      // Acknowledge fast (within Telegram's 30s window) so the user
      // doesn't see a perpetual loading spinner.
      if (action.kind === "done") {
        await ctx.answerCallbackQuery({ text: "Done" });
        try {
          await ctx.deleteMessage();
        } catch {
          /* might lack delete permission */
        }
        return;
      }
      if (action.kind === "noop" || action.kind === "unknown") {
        await ctx.answerCallbackQuery();
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
        if (be?.resolveModel) {
          const resolution = await be.resolveModel(action.modelId);
          if (resolution.kind !== "exact" || !resolution.model.selectable) {
            await ctx.answerCallbackQuery({
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
          await ctx.answerCallbackQuery({
            text: "Backend not available",
          });
          return;
        }
        const result = await rebindChat(cid, action.backendId, config);
        if (!result.ok) {
          await ctx.answerCallbackQuery({
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
        await releaseChat(cid);
        setChatBackend(cid, undefined);
        resetSession(cid);
        clearHistory(cid);
        resetPulseCheckpoint(cid);
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
        await ctx.answerCallbackQuery({ text: toast });
      } else {
        await ctx.answerCallbackQuery();
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
      return;
    }

    // Forward other callbacks to the AI backend
    handleCallbackQuery(ctx, bot, config);
  });
}
