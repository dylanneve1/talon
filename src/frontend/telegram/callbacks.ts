/**
 * All callback_query handlers (settings panel, model/effort selectors, proactive toggle).
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../util/config.js";
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
  renderSettingsText,
  renderSettingsKeyboard,
  type SettingsButton,
} from "./helpers.js";

export function registerCallbacks(
  bot: Bot,
  config: TalonConfig,
  gateway?: { backend: import("../../core/types.js").QueryBackend | null },
): void {
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
        if (value === "reset") {
          setChatModel(cid, undefined);
        } else if (gateway?.backend?.resolveModel) {
          const resolution = await gateway.backend.resolveModel(value);
          if (resolution.kind !== "exact") {
            await ctx.answerCallbackQuery({ text: "Model is unavailable" });
            return;
          }
          if (!resolution.model.selectable) {
            await ctx.answerCallbackQuery({
              text: resolution.model.unavailableReason ?? "Unavailable",
            });
            return;
          }
          setChatModel(cid, resolution.storedValue);
        } else {
          setChatModel(cid, resolveModelName(value));
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
      let modelButtons: Array<SettingsButton> | undefined;

      if (gateway?.backend?.getSettingsPresentation) {
        const presentation =
          await gateway.backend.getSettingsPresentation(activeModel);
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

    // Handle model callbacks (from /model quick-pick buttons)
    if (data.startsWith("model:")) {
      const model = data.slice(6);
      if (model === "reset") {
        setChatModel(cid, undefined);
        await ctx.answerCallbackQuery({
          text: `Model: ${config.model} (default)`,
        });
      } else if (gateway?.backend?.resolveModel) {
        const resolution = await gateway.backend.resolveModel(model);
        if (resolution.kind === "exact" && resolution.model.selectable) {
          setChatModel(cid, resolution.storedValue);
          await ctx.answerCallbackQuery({
            text: `Model: ${resolution.storedValue}`,
          });
        } else {
          await ctx.answerCallbackQuery({ text: "Model is unavailable" });
          return;
        }
      } else {
        setChatModel(cid, resolveModelName(model));
        await ctx.answerCallbackQuery({
          text: `Model: ${getChatSettings(cid).model ?? config.model}`,
        });
      }
      // Refresh the model picker buttons
      const current = getChatSettings(cid).model ?? config.model;
      const be = gateway?.backend;
      if (be?.getSettingsPresentation) {
        const pres = await be.getSettingsPresentation(current);
        const rows: Array<Array<{ text: string; callback_data: string }>> = [];
        for (let i = 0; i < pres.modelButtons.length; i += 2) {
          rows.push(pres.modelButtons.slice(i, i + 2));
        }
        rows.push([{ text: "Reset to default", callback_data: "model:reset" }]);
        try {
          await ctx.editMessageText(
            `<b>Model:</b> <code>${escapeHtml(current)}</code>`,
            { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } },
          );
        } catch {
          /* message unchanged */
        }
      }
      return;
    }

    // Forward other callbacks to Claude
    handleCallbackQuery(ctx, bot, config);
  });
}
