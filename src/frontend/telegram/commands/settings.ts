/**
 * Settings commands — /model, /effort, /pulse, /settings.
 */

import type { Bot } from "grammy";
import {
  getChatSettings,
  setChatModelForBackend,
  setChatBackend,
  setChatEffort,
  setChatPulseInterval,
  type EffortLevel,
} from "../../../storage/chat-settings.js";
import { resolveModelId as resolveModelName } from "../../../core/models/catalog.js";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
} from "../../../core/background/pulse.js";
import { escapeHtml } from "../formatting.js";
import {
  formatModelLabel,
  formatDuration,
  parseInterval,
  renderSettingsText,
  renderSettingsKeyboard,
  renderEffortRows,
  renderModelMenuText,
  renderModelMenuKeyboard,
  type SettingsButton,
} from "../helpers/index.js";
import {
  buildModelMenuViewForChat,
  resolveBackendForChat,
} from "../model-menu.js";
import { getBackendIdForChat } from "../../../core/engine/backend-controller/index.js";
import { resolveActiveModelForChat } from "../../../core/models/active-model.js";
import {
  displayReasoningEffort,
  getActiveReasoningLevels,
  supportsReasoningLevel,
} from "../../shared/reasoning-levels.js";
import type { RegisterDeps } from "./state.js";

export function registerSettingsCommands(
  bot: Bot,
  { config, gateway }: RegisterDeps,
): void {
  bot.command("model", async (ctx) => {
    const cid = String(ctx.chat.id);
    const arg = ctx.match?.trim();
    // Resolve through the active-backend-aware helper. Returns null
    // when the catalog-driven backend has no per-chat pick AND no
    // operator default — UI surfaces that as "No model selected".
    const be = resolveBackendForChat(cid, gateway);
    const beId = getBackendIdForChat(cid);
    const { model: resolvedActive } = await resolveActiveModelForChat(
      cid,
      be,
      beId,
      config,
    );
    const activeModel = resolvedActive ?? "No model selected";

    if (
      !arg ||
      arg.toLowerCase() === "reset" ||
      arg.toLowerCase() === "default"
    ) {
      if (arg) {
        // Clear THIS backend's slot only — other backends' picks stay.
        setChatModelForBackend(cid, beId, undefined);
        const { model: postResetModel } = await resolveActiveModelForChat(
          cid,
          be,
          beId,
          config,
        );
        const body = postResetModel
          ? `Model reset to default: <code>${escapeHtml(postResetModel)}</code>`
          : `Model reset — no default available for backend <code>${escapeHtml(beId)}</code>. Use /model to pick one.`;
        await ctx.reply(body, { parse_mode: "HTML" });
        return;
      }
      // Render the main /model menu. Browsing the catalog happens
      // behind the "Browse models" button — see callbacks.ts. The
      // controller resolves the per-chat backend so the menu reflects
      // any active per-chat override (e.g. a chat switched to
      // openai-agents in a Claude-default install).
      const view = await buildModelMenuViewForChat(cid, config, gateway);
      if (view) {
        await ctx.reply(renderModelMenuText(view.state), {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: renderModelMenuKeyboard(view.state),
          },
        });
      } else {
        await ctx.reply(
          `<b>Model:</b> <code>${escapeHtml(formatModelLabel(activeModel))}</code>`,
          {
            parse_mode: "HTML",
          },
        );
      }
      return;
    }

    // `be` + `beId` already resolved above for the activeModel lookup.
    // Reuse them — they point at the per-chat backend (override-aware).
    if (be?.models?.resolveModelInfo) {
      const resolution = await be.models?.resolveModelInfo(arg);
      if (resolution.kind !== "exact") {
        // Every backend's formatModelError returns plain text and
        // interpolates the raw query, so escape at this boundary — the
        // same fix as the model menu's status lines. `/model <name>`
        // (which the OpenCode/Kilo hint literally tells you to type)
        // otherwise reaches Telegram as an unsupported `<name>` tag and
        // the whole reply 400s, leaving the command looking dead.
        const msg =
          be.models?.formatModelError?.(arg, resolution) ??
          `No model matched "${arg}".`;
        await ctx.reply(escapeHtml(msg), { parse_mode: "HTML" });
        return;
      }
      if (!resolution.model.selectable) {
        const msg =
          resolution.model.unavailableReason ??
          `${resolution.model.providerName} is not connected.`;
        await ctx.reply(escapeHtml(msg), { parse_mode: "HTML" });
        return;
      }
      setChatModelForBackend(cid, beId, resolution.storedValue);
      setChatBackend(cid, beId);
      await ctx.reply(
        `Model set to <code>${escapeHtml(resolution.storedValue)}</code> (${escapeHtml(resolution.model.providerName)}${resolution.model.free ? " · free" : ""}).`,
        { parse_mode: "HTML" },
      );
    } else {
      // Fallback for backends without model resolution
      const model = resolveModelName(arg);
      setChatModelForBackend(cid, beId, model);
      setChatBackend(cid, beId);
      await ctx.reply(
        `Model set to <code>${escapeHtml(formatModelLabel(model))}</code>.`,
        { parse_mode: "HTML" },
      );
    }
  });

  bot.command("effort", async (ctx) => {
    const cid = String(ctx.chat.id);
    const arg = ctx.match?.trim().toLowerCase();
    const settings = getChatSettings(cid);
    const be = resolveBackendForChat(cid, gateway);
    const beId = getBackendIdForChat(cid);
    const reasoning = await getActiveReasoningLevels({
      chatId: cid,
      backend: be,
      backendId: beId,
      config,
    });

    if (reasoning.levels.length === 0) {
      const modelText = reasoning.activeModel
        ? `<code>${escapeHtml(formatModelLabel(reasoning.activeModel))}</code>`
        : "the active model";
      await ctx.reply(
        `No valid reasoning levels found for ${modelText} on backend <code>${escapeHtml(beId)}</code>.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (!arg) {
      const current = displayReasoningEffort(settings.effort, reasoning.levels);
      await ctx.reply(`<b>Effort:</b> ${current}\nSelect a level:`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: renderEffortRows(
            current,
            reasoning.levels,
            "effort:",
          ),
        },
      });
      return;
    }

    if (arg === "reset" || arg === "default" || arg === "adaptive") {
      setChatEffort(cid, undefined);
      await ctx.reply(
        "Effort reset to <b>adaptive</b> (model decides when to think)",
        { parse_mode: "HTML" },
      );
      return;
    }

    if (supportsReasoningLevel(arg, reasoning.levels)) {
      setChatEffort(cid, arg as EffortLevel);
      await ctx.reply(`Effort set to <b>${arg}</b>`, { parse_mode: "HTML" });
      return;
    }

    await ctx.reply(
      `Unknown level for this model. Valid: ${reasoning.levels.join(", ")}, or adaptive.`,
    );
  });

  bot.command("pulse", async (ctx) => {
    const cid = String(ctx.chat.id);
    const arg = ctx.match?.trim().toLowerCase();

    if (!arg || arg === "status") {
      const enabled = isPulseEnabled(cid);
      await ctx.reply(
        [
          `<b>🔔 Pulse:</b> ${enabled ? "on" : "off"}`,
          "",
          "Reads along every few minutes and jumps in when there's something to add.",
        ].join("\n"),
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
      return;
    }

    if (arg === "on" || arg === "enable") {
      enablePulse(cid);
      registerChat(cid);
      await ctx.reply("🔔 Pulse enabled.");
      return;
    }

    if (arg === "off" || arg === "disable") {
      disablePulse(cid);
      await ctx.reply("🔔 Pulse disabled.");
      return;
    }

    const intervalMs = parseInterval(arg);
    if (intervalMs && intervalMs >= 5 * 60 * 1000) {
      setChatPulseInterval(cid, intervalMs);
      enablePulse(cid);
      registerChat(cid);
      await ctx.reply(
        `🔔 Pulse cooldown set to <b>${formatDuration(intervalMs)}</b>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (intervalMs) {
      await ctx.reply("Minimum interval is 5 minutes.");
      return;
    }

    await ctx.reply("Use: /pulse on, /pulse off, /pulse 30m, /pulse 2h");
  });

  bot.command("settings", async (ctx) => {
    const cid = String(ctx.chat.id);
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
    const reasoning = await getActiveReasoningLevels({
      chatId: cid,
      backend: settingsBe,
      backendId: settingsBeId,
      config,
    });
    const effortName = displayReasoningEffort(
      chatSets.effort,
      reasoning.levels,
    );
    const pulseOn = isPulseEnabled(cid);
    let modelButtons: Array<SettingsButton> | undefined;
    let pager:
      | {
          page: number;
          totalPages: number;
          filter: "all" | "free";
          freeCount: number;
          totalCount: number;
          provider?: string;
        }
      | undefined;
    let view: "models" | "groups" = "models";
    let activeProvider: string | undefined;
    if (settingsBe?.models?.getSettingsPresentation && resolvedSettingsModel) {
      const pres = await settingsBe.models?.getSettingsPresentation(
        resolvedSettingsModel,
      );
      modelButtons = pres.modelButtons;
      pager = {
        page: pres.page,
        totalPages: pres.totalPages,
        filter: pres.filter,
        freeCount: pres.freeCount,
        totalCount: pres.totalCount,
        provider: pres.provider,
      };
      view = pres.view;
      activeProvider = pres.provider;
    }

    await ctx.reply(
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
            modelButtons,
            pager,
            view,
            activeProvider,
            reasoning.levels,
          ),
        },
      },
    );
  });
}
