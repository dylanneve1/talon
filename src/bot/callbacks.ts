/**
 * All callback_query handlers (settings panel, model/effort selectors, proactive toggle).
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../util/config.js";
import { resetSession } from "../storage/sessions.js";
import {
  getChatSettings,
  setChatModel,
  setChatEffort,
  resolveModelName,
  EFFORT_LEVELS,
  type EffortLevel,
} from "../storage/chat-settings.js";
import {
  registerChatForProactive,
  disableProactive,
  enableProactive,
  isProactiveEnabled,
} from "../agent/proactive.js";
import {
  handleCallbackQuery,
  escapeHtml,
  getSenderName,
  processAndReply,
} from "./handlers.js";
import {
  renderSettingsText,
  renderSettingsKeyboard,
} from "./helpers.js";
import { logError } from "../util/log.js";

export function registerCallbacks(bot: Bot, config: TalonConfig): void {
  // ── Edited message handler ──────────────────────────────────────────────────

  bot.on("edited_message:text", async (ctx) => {
    if (!ctx.editedMessage || !ctx.chat) return;
    const chatId = String(ctx.chat.id);
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";

    if (isGroup) {
      const text = ctx.editedMessage.text || "";
      const botUser = ctx.me.username;
      const mentioned =
        botUser && text.toLowerCase().includes(`@${botUser.toLowerCase()}`);
      const repliedToBot =
        ctx.editedMessage.reply_to_message?.from?.id === ctx.me.id;
      if (!mentioned && !repliedToBot) return;
    }

    const sender = getSenderName(ctx.from);
    const senderUsername = ctx.from?.username;
    const msgId = ctx.editedMessage.message_id;
    const newText = ctx.editedMessage.text || "";

    const prompt = `[Message edited] User edited msg:${msgId} to: "${newText}"`;

    try {
      await processAndReply(
        bot,
        config,
        chatId,
        ctx.chat.id,
        msgId,
        msgId,
        prompt,
        sender,
        isGroup,
        senderUsername,
      );
    } catch (err) {
      logError("bot", `[${chatId}] Edit handler error`, err);
    }
  });

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
          resetSession(cid);
        } else {
          const resolved = resolveModelName(value);
          setChatModel(cid, resolved);
          resetSession(cid);
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
          enableProactive(cid);
          registerChatForProactive(cid);
        } else {
          disableProactive(cid);
        }
        await ctx.answerCallbackQuery({ text: `Proactive: ${value}` });
      }

      const chatSets = getChatSettings(cid);
      const activeModel = chatSets.model ?? config.model;
      const effortName = chatSets.effort ?? "adaptive";
      const proactiveOn = isProactiveEnabled(cid);

      try {
        await ctx.editMessageText(
          renderSettingsText(
            activeModel,
            effortName,
            proactiveOn,
            chatSets.proactiveIntervalMs,
          ),
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: renderSettingsKeyboard(
                activeModel,
                effortName,
                proactiveOn,
              ),
            },
          },
        );
      } catch {
        /* message unchanged */
      }
      return;
    }

    // Handle proactive callbacks
    if (data.startsWith("proactive:")) {
      const val = data.slice(10);
      if (val === "on") {
        enableProactive(cid);
        registerChatForProactive(cid);
        await ctx.answerCallbackQuery({ text: "Proactive: on" });
      } else {
        disableProactive(cid);
        await ctx.answerCallbackQuery({ text: "Proactive: off" });
      }
      const enabled = isProactiveEnabled(cid);
      try {
        await ctx.editMessageText(
          `<b>Proactive:</b> ${enabled ? "on" : "off"}\nPeriodically checks chat and responds if there's something to add.`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: enabled ? "\u2713 On" : "On",
                    callback_data: "proactive:on",
                  },
                  {
                    text: !enabled ? "\u2713 Off" : "Off",
                    callback_data: "proactive:off",
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
        resetSession(cid);
        await ctx.answerCallbackQuery({
          text: `Model: ${config.model} (default)`,
        });
      } else {
        const resolved = resolveModelName(model);
        setChatModel(cid, resolved);
        resetSession(cid);
        await ctx.answerCallbackQuery({
          text: `Model: ${resolved}. Session reset.`,
        });
      }
      const current = getChatSettings(cid).model ?? config.model;
      const isModel = (id: string) => current.includes(id);
      try {
        await ctx.editMessageText(
          `<b>Model:</b> <code>${escapeHtml(current)}</code>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: isModel("sonnet") ? "\u2713 Sonnet 4.6" : "Sonnet 4.6",
                    callback_data: "model:sonnet",
                  },
                  {
                    text: isModel("opus") ? "\u2713 Opus 4.6" : "Opus 4.6",
                    callback_data: "model:opus",
                  },
                ],
                [
                  {
                    text: isModel("haiku") ? "\u2713 Haiku 4.5" : "Haiku 4.5",
                    callback_data: "model:haiku",
                  },
                  { text: "Reset to default", callback_data: "model:reset" },
                ],
              ],
            },
          },
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
