/**
 * All callback_query handlers (settings panel, model/effort selectors, proactive toggle).
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../util/config.js";
import { getOpenCodeModelSelectionValue } from "../../backend/opencode/index.js";

import {
  getChatSettings,
  setChatModel,
  setChatEffort,
  resolveModelName,
  EFFORT_LEVELS,
  type EffortLevel,
} from "../../storage/chat-settings.js";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
} from "../../core/pulse.js";
import { handleCallbackQuery } from "./handlers.js";
import { escapeHtml } from "./formatting.js";
import {
  formatModelLabel,
  formatModelOptionLabel,
  getTelegramModelOptions,
  isSelectedModel,
  renderSettingsText,
  renderSettingsKeyboard,
} from "./helpers.js";
import {
  getOpenCodeSettingsPresentation,
  resolveOpenCodeModelSelection,
  type TelegramInlineButton,
} from "./opencode-ui.js";

export function registerCallbacks(bot: Bot, config: TalonConfig): void {
  // ── Callback query handler ──────────────────────────────────────────────────

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const cid = String(ctx.chat?.id ?? ctx.from.id);

    // Handle unified /settings callbacks
    if (data.startsWith("settings:")) {
      const parts = data.split(":");
      if (!parts[1]) {
        await ctx.answerCallbackQuery({ text: "Invalid callback data" });
        return;
      }
      const category = parts[1];
      const value = parts[2] ?? "";

      if (category === "done") {
        await ctx.answerCallbackQuery({ text: "Done" });
        try {
          await ctx.deleteMessage();
        } catch {
          // might not have permission to delete
        }
        return;
      }

      if (category === "model") {
        if (config.backend === "opencode") {
          if (value === "reset") {
            setChatModel(cid, undefined);
          } else {
            const { catalog, resolution } =
              await resolveOpenCodeModelSelection(value);
            if (resolution.kind !== "exact") {
              await ctx.answerCallbackQuery({ text: "Model is unavailable" });
              return;
            }
            if (!resolution.model.selectable) {
              const detail = resolution.model.loginRequired
                ? `${resolution.model.providerName}: login required`
                : resolution.model.envRequired
                  ? `${resolution.model.providerName}: credentials required`
                  : `${resolution.model.providerName}: unavailable`;
              await ctx.answerCallbackQuery({ text: detail });
              return;
            }
            setChatModel(
              cid,
              getOpenCodeModelSelectionValue(resolution.model, catalog),
            );
          }
        } else {
          if (value === "reset") {
            setChatModel(cid, undefined);
          } else {
            const resolved = resolveModelName(value);
            setChatModel(cid, resolved);
          }
        }
        await ctx.answerCallbackQuery({
          text: `Model: ${getChatSettings(cid).model ?? config.model}`,
        });
      } else if (category === "effort") {
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
      const activeModel = chatSets.model ?? config.model;
      const effortName = chatSets.effort ?? "adaptive";
      const pulseOn = isPulseEnabled(cid);
      let modelDetails: Array<string> | undefined;
      let modelButtons: Array<TelegramInlineButton> | undefined;

      if (config.backend === "opencode") {
        const presentation = await getOpenCodeSettingsPresentation(activeModel);
        modelDetails = presentation.modelDetails;
        modelButtons = presentation.modelButtons;
      }

      try {
        await ctx.editMessageText(
          renderSettingsText(
            activeModel,
            effortName,
            pulseOn,
            chatSets.pulseIntervalMs,
            modelDetails,
          ),
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: renderSettingsKeyboard(
                activeModel,
                effortName,
                pulseOn,
                modelButtons,
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

    // Handle model callbacks
    if (data.startsWith("model:")) {
      const model = data.slice(6);
      if (model === "reset") {
        setChatModel(cid, undefined);
        await ctx.answerCallbackQuery({
          text: `Model: ${formatModelLabel(config.model)} (default)`,
        });
      } else {
        const resolved = resolveModelName(model);
        setChatModel(cid, resolved);
        await ctx.answerCallbackQuery({
          text: `Model: ${formatModelLabel(resolved)}`,
        });
      }
      const current = getChatSettings(cid).model ?? config.model;
      // Build model buttons dynamically from the registry
      const models = getTelegramModelOptions();
      const modelButtons = models.map((m) => ({
        text: isSelectedModel(current, m.id)
          ? `\u2713 ${formatModelOptionLabel(m)}`
          : formatModelOptionLabel(m),
        callback_data: `model:${m.id}`,
      }));
      const rows: Array<Array<{ text: string; callback_data: string }>> = [];
      for (let i = 0; i < modelButtons.length; i += 2) {
        rows.push(modelButtons.slice(i, i + 2));
      }
      rows.push([{ text: "Reset to default", callback_data: "model:reset" }]);
      try {
        await ctx.editMessageText(
          `<b>Model:</b> <code>${escapeHtml(formatModelLabel(current))}</code>`,
          { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } },
        );
      } catch {
        /* message unchanged */
      }
      return;
    }

    // Forward other callbacks to Claude
    handleCallbackQuery(ctx, bot, config);
  });
}
