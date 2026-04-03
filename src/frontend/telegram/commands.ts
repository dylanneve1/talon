/**
 * All /command handlers for the Telegram bot.
 */

import type { Bot } from "grammy";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { TalonConfig } from "../../util/config.js";
import {
  getSessionInfo,
} from "../../storage/sessions.js";
import {
  getChatSettings,
  setChatPulseInterval,
} from "../../storage/chat-settings.js";
import {
  registerChat,
  enablePulse,
  isPulseEnabled,
} from "../../core/pulse.js";
import { forceDream } from "../../core/dream.js";
import { isUserClientReady } from "./userbot.js";
import { appendDailyLog } from "../../storage/daily-log.js";
import { escapeHtml } from "./formatting.js";
import { handleAdminCommand } from "./admin.js";
import {
  formatDuration,
  parseInterval,
  renderSettingsKeyboard,
} from "./helpers.js";
import {
  renderHelp,
  renderStatus,
  renderSettings,
  renderPing,
  renderMemory,
  renderPlugins,
  handleModelCommand,
  handleEffortCommand,
  handlePulseCommand,
  handleReset,
} from "./command-ui.js";

// Admin user ID is set via talon.json or TALON_ADMIN_USER_ID env var
let ADMIN_USER_ID = 0;

/** Set the admin user ID (called from config at startup). */
export function setAdminUserId(id: number | undefined): void {
  ADMIN_USER_ID = id ?? 0;
}

export function registerCommands(bot: Bot, config: TalonConfig): void {
  bot.command("start", (ctx) =>
    ctx.reply(
      [
        "<b>\uD83E\uDD85 Talon</b>",
        "",
        "Claude-powered Telegram assistant with 31 tools.",
        "",
        "Send a message, photo, doc, or voice note.",
        "In groups, @mention or reply to activate.",
        "",
        "/status  /reset  /help",
      ].join("\n"),
      { parse_mode: "HTML" },
    ),
  );

  bot.command("help", (ctx) =>
    ctx.reply(renderHelp(ctx.me.username, "html"), { parse_mode: "HTML" }),
  );

  bot.command("reset", async (ctx) => {
    const cid = String(ctx.chat.id);
    const info = getSessionInfo(cid);

    if (info.turns > 0) {
      const duration = info.createdAt
        ? formatDuration(Date.now() - info.createdAt)
        : "unknown";
      const modelNote =
        info.turns > 5 && info.lastModel ? ` | model: ${info.lastModel}` : "";
      const nameNote = info.sessionName ? ` "${info.sessionName}"` : "";
      appendDailyLog(
        "System",
        `Session reset${nameNote}: ${info.turns} turns, ${duration}${modelNote}`,
      );
    }

    await ctx.reply(handleReset(cid));
  });

  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const sent = await ctx.reply("...");
    const latencyMs = Date.now() - start;

    try {
      await bot.api.editMessageText(
        ctx.chat.id,
        sent.message_id,
        renderPing(latencyMs, isUserClientReady()),
      );
    } catch {
      // ignore edit failure
    }
  });

  bot.command("model", async (ctx) => {
    const cid = String(ctx.chat.id);
    const arg = ctx.match?.trim() || undefined;

    if (!arg) {
      const current = getChatSettings(cid).model ?? config.model;
      const isModel = (id: string) => current.includes(id);
      await ctx.reply(handleModelCommand(cid, undefined, config.model, "html"), {
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
      });
      return;
    }

    await ctx.reply(handleModelCommand(cid, arg, config.model, "html"), { parse_mode: "HTML" });
  });

  bot.command("effort", async (ctx) => {
    const cid = String(ctx.chat.id);
    const arg = ctx.match?.trim().toLowerCase() || undefined;

    if (!arg) {
      const current = getChatSettings(cid).effort ?? "adaptive";
      await ctx.reply(handleEffortCommand(cid, undefined, "html"), {
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
      return;
    }

    await ctx.reply(handleEffortCommand(cid, arg, "html"), { parse_mode: "HTML" });
  });

  bot.command("pulse", async (ctx) => {
    const cid = String(ctx.chat.id);
    const arg = ctx.match?.trim().toLowerCase() || undefined;

    if (!arg || arg === "status") {
      const enabled = isPulseEnabled(cid);
      await ctx.reply(handlePulseCommand(cid, undefined, "html"), {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: enabled ? "✓ On" : "On", callback_data: "pulse:on" },
            { text: !enabled ? "✓ Off" : "Off", callback_data: "pulse:off" },
          ]],
        },
      });
      return;
    }

    if (arg === "on" || arg === "enable") {
      registerChat(cid);
      await ctx.reply(handlePulseCommand(cid, arg, "html"));
      return;
    }

    if (arg === "off" || arg === "disable") {
      await ctx.reply(handlePulseCommand(cid, arg, "html"));
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

    await ctx.reply(handlePulseCommand(cid, arg, "html"));
  });

  bot.command("memory", async (ctx) => {
    await ctx.reply(renderMemory());
  });

  bot.command("settings", async (ctx) => {
    const cid = String(ctx.chat.id);
    const chatSets = getChatSettings(cid);
    const activeModel = chatSets.model ?? config.model;
    const effortName = chatSets.effort ?? "adaptive";
    const pulseOn = isPulseEnabled(cid);

    await ctx.reply(renderSettings(cid, config.model, "html"), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: renderSettingsKeyboard(
          activeModel,
          effortName,
          pulseOn,
        ),
      },
    });
  });

  bot.command("admin", async (ctx) => {
    if (ctx.from?.id !== ADMIN_USER_ID) {
      await ctx.reply("Not authorized.");
      return;
    }
    await handleAdminCommand(ctx, bot, config);
  });

  bot.command("status", async (ctx) => {
    const cid = String(ctx.chat.id);
    await ctx.reply(renderStatus(cid, config.model, "html"), { parse_mode: "HTML" });
  });

  bot.command("dream", async (ctx) => {
    if (ADMIN_USER_ID && ctx.from?.id !== ADMIN_USER_ID) {
      await ctx.reply("Not authorized.");
      return;
    }
    const sent = await ctx.reply("🌙 Dream mode starting...");
    const start = Date.now();
    // Fire-and-forget — don't await, so grammY can keep processing other updates
    forceDream()
      .then(async () => {
        const elapsed = formatDuration(Date.now() - start);
        await bot.api.editMessageText(
          ctx.chat.id,
          sent.message_id,
          `🌙 Dream complete — memory consolidated in ${elapsed}.`,
        );
      })
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        await bot.api.editMessageText(
          ctx.chat.id,
          sent.message_id,
          `🌙 Dream failed: ${escapeHtml(msg)}`,
          { parse_mode: "HTML" },
        );
      });
  });

  bot.command("restart", async (ctx) => {
    if (ADMIN_USER_ID && ctx.from?.id !== ADMIN_USER_ID) {
      await ctx.reply("Not authorized.");
      return;
    }
    await ctx.reply("♻️ Restarting...");

    setTimeout(() => {
      // Try `talon restart` (handles daemon stop+start cleanly).
      // Fall back to the local bin if talon isn't on PATH globally.
      const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const localBin = resolve(projectRoot, "bin/talon.js");

      const trySpawn = (cmd: string, args: string[]): Promise<void> =>
        new Promise((res, rej) => {
          const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
          child.on("error", rej);
          child.on("spawn", () => { child.unref(); res(); });
        });

      // Try global first, then local bin, then just exit (let process manager restart)
      trySpawn("talon", ["restart"])
        .catch(() => trySpawn(process.execPath, [localBin, "restart"]))
        .catch(() => {})
        .finally(() => process.exit(0));
    }, 500);
  });

  bot.command("plugins", async (ctx) => {
    await ctx.reply(renderPlugins("html"), { parse_mode: "HTML" });
  });
}
