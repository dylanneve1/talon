/**
 * All /command handlers for the Telegram bot.
 */

import type { Bot } from "grammy";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { TalonConfig } from "../../util/config.js";
import { files } from "../../util/paths.js";
import {
  resetSession,
  getSessionInfo,
  getActiveSessionCount,
} from "../../storage/sessions.js";
import { clearHistory } from "../../storage/history.js";
import {
  getChatSettings,
  setChatModel,
  setChatEffort,
  setChatPulseInterval,
  resolveModelName,
  EFFORT_LEVELS,
  type EffortLevel,
} from "../../storage/chat-settings.js";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
  resetPulseCheckpoint,
} from "../../core/pulse.js";
import { forceDream } from "../../core/dream.js";
import { isUserClientReady } from "./userbot.js";
import { getWorkspaceDiskUsage } from "../../util/workspace.js";
import { appendDailyLog } from "../../storage/daily-log.js";
import { escapeHtml } from "./formatting.js";
import { handleAdminCommand } from "./admin.js";
import { getLoadedPlugins } from "../../core/plugin.js";
import {
  formatDuration,
  formatTokenCount,
  formatBytes,
  parseInterval,
  renderSettingsText,
  renderSettingsKeyboard,
} from "./helpers.js";

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
    ctx.reply(
      [
        "<b>\uD83E\uDD85 Talon -- Help</b>",
        "",
        "<b>\uD83E\uDD85 Settings</b>",
        "  /settings -- view and change all chat settings",
        "  /model -- show or change model (sonnet, opus, haiku)",
        "  /effort -- set thinking effort (off, low, medium, high, max)",
        "  /pulse -- toggle periodic check-ins (on/off)",
        "",
        "<b>Session</b>",
        "  /status -- session info, usage, and stats",
        "  /memory -- view what Talon remembers",
        "  /dream -- force memory consolidation now",
        "  /ping -- health check with latency",
        "  /reset -- clear session and start fresh",
        "  /restart -- restart the bot process",
        "  /plugins -- list loaded plugins",
        "  /help -- this message",
        "",
        "<b>Input</b>",
        "  Text, photos, documents, voice notes, audio, videos, GIFs, stickers, video notes, forwarded messages, reply context",
        "",
        "<b>Messaging</b>",
        "  Send, reply, edit, delete, forward, copy, pin/unpin messages. Inline keyboards with callback buttons. Scheduled messages.",
        "",
        "<b>Media</b>",
        "  Send photos, videos, GIFs, voice notes, stickers, files, polls, locations, contacts, dice.",
        "",
        "<b>Chat</b>",
        "  Read history, search messages, list members, get chat info, manage titles and descriptions.",
        "",
        "<b>Web</b>",
        "  Ask Talon to read a URL — it can fetch and summarize web pages.",
        "",
        "<b>Groups</b>",
        "  Mention @" +
          escapeHtml(ctx.me.username ?? "bot") +
          " or reply to activate.",
        "",
        "<b>Files</b>",
        "  Ask me to create a file and I'll send it as an attachment.",
      ].join("\n"),
      { parse_mode: "HTML" },
    ),
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

    resetSession(cid);
    clearHistory(cid);
    resetPulseCheckpoint(cid);
    await ctx.reply("Session cleared.");
  });

  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const sent = await ctx.reply("...");
    const latency = Date.now() - start;

    const bridgeOk = true;
    const userbotOk = isUserClientReady();
    const uptime = formatDuration(process.uptime() * 1000);

    const statusLine = [
      `Bridge: ${bridgeOk ? "\u2713" : "\u2717"}`,
      `Userbot: ${userbotOk ? "\u2713" : "\u2717"}`,
      `Uptime: ${uptime}`,
    ].join(" | ");

    try {
      await bot.api.editMessageText(
        ctx.chat.id,
        sent.message_id,
        `Pong! ${latency}ms\n${statusLine}`,
      );
    } catch {
      // ignore edit failure
    }
  });

  bot.command("model", async (ctx) => {
    const cid = String(ctx.chat.id);
    const arg = ctx.match?.trim();
    const settings = getChatSettings(cid);

    if (!arg) {
      const current = settings.model ?? config.model;
      const isModel = (id: string) => current.includes(id);
      await ctx.reply(
        `<b>Model:</b> <code>${escapeHtml(current)}</code>\nSelect a model:`,
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
      return;
    }

    if (arg === "reset" || arg === "default") {
      setChatModel(cid, undefined);
      await ctx.reply(
        `Model reset to default: <code>${escapeHtml(config.model)}</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const model = resolveModelName(arg);
    setChatModel(cid, model);
    await ctx.reply(`Model set to <code>${escapeHtml(model)}</code>.`, {
      parse_mode: "HTML",
    });
  });

  bot.command("effort", async (ctx) => {
    const cid = String(ctx.chat.id);
    const arg = ctx.match?.trim().toLowerCase();
    const settings = getChatSettings(cid);

    if (!arg) {
      const current = settings.effort ?? "adaptive";
      await ctx.reply(`<b>Effort:</b> ${current}\nSelect a level:`, {
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

    if (arg === "reset" || arg === "default" || arg === "adaptive") {
      setChatEffort(cid, undefined);
      await ctx.reply(
        "Effort reset to <b>adaptive</b> (Claude decides when to think)",
        { parse_mode: "HTML" },
      );
      return;
    }

    if (EFFORT_LEVELS.includes(arg as EffortLevel)) {
      setChatEffort(cid, arg as EffortLevel);
      await ctx.reply(`Effort set to <b>${arg}</b>`, { parse_mode: "HTML" });
      return;
    }

    await ctx.reply(
      "Unknown level. Use: off, low, medium, high, max, or adaptive.",
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

  bot.command("memory", async (ctx) => {
    try {
      const memoryPath = files.memory;
      if (!existsSync(memoryPath)) {
        await ctx.reply(
          "No memory file yet. I'll create one as I learn about you.",
        );
        return;
      }
      const content = readFileSync(memoryPath, "utf-8").trim();
      if (!content) {
        await ctx.reply("Memory file is empty. I'll update it as we chat.");
        return;
      }
      // Truncate for Telegram's 4096 char limit
      const display =
        content.length > 3500
          ? content.slice(0, 3500) + "\n\n... (truncated)"
          : content;
      await ctx.reply(display);
    } catch {
      await ctx.reply("Could not read memory file.");
    }
  });

  bot.command("settings", async (ctx) => {
    const cid = String(ctx.chat.id);
    const chatSets = getChatSettings(cid);
    const activeModel = chatSets.model ?? config.model;
    const effortName = chatSets.effort ?? "adaptive";
    const pulseOn = isPulseEnabled(cid);

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
          ),
        },
      },
    );
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
    const info = getSessionInfo(cid);
    const u = info.usage;
    const uptime = formatDuration(process.uptime() * 1000);
    const sessionAge = info.createdAt
      ? formatDuration(Date.now() - info.createdAt)
      : "\u2014";
    const chatSets = getChatSettings(cid);
    const activeModel = chatSets.model ?? config.model;
    const effortName = chatSets.effort ?? "adaptive";
    const pulseOn = isPulseEnabled(cid);

    const contextMax = activeModel.includes("haiku") ? 200_000 : 1_000_000;
    const contextUsed = u.lastPromptTokens;
    const contextPct =
      contextMax > 0
        ? Math.min(100, Math.round((contextUsed / contextMax) * 100))
        : 0;
    const barLen = 20;
    const filled = Math.round((contextPct / 100) * barLen);
    const contextBar =
      "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
    const contextWarn = contextPct >= 80 ? " \u26A0\uFE0F consider /reset" : "";

    const totalPrompt =
      u.totalInputTokens + u.totalCacheRead + u.totalCacheWrite;
    const cacheHitPct =
      totalPrompt > 0 ? Math.round((u.totalCacheRead / totalPrompt) * 100) : 0;

    const avgResponseMs =
      info.turns > 0 && u.totalResponseMs
        ? Math.round(u.totalResponseMs / info.turns)
        : 0;
    const lastResponseMs = u.lastResponseMs || 0;
    const fastestMs =
      u.fastestResponseMs === Infinity ? 0 : u.fastestResponseMs || 0;

    const diskBytes = getWorkspaceDiskUsage(config.workspace);
    const diskStr = formatBytes(diskBytes);

    const lines = [
      `<b>\uD83E\uDD85 Talon</b> \u00B7 <code>${escapeHtml(activeModel)}</code> \u00B7 effort: ${effortName}`,
      "",
      `<b>Context</b>  ${formatTokenCount(contextUsed)} / ${formatTokenCount(contextMax)} (${contextPct}%)${contextWarn}`,
      `<code>${contextBar}</code>`,
      "",
      `<b>Session Stats</b>`,
      `  Response  last ${lastResponseMs ? formatDuration(lastResponseMs) : "\u2014"} \u00B7 avg ${avgResponseMs ? formatDuration(avgResponseMs) : "\u2014"} \u00B7 best ${fastestMs ? formatDuration(fastestMs) : "\u2014"}`,
      `  Turns     ${info.turns}${info.lastModel ? ` (${info.lastModel.replace("claude-", "")})` : ""}`,
      "",
      `<b>Cache</b>     ${cacheHitPct}% hit`,
      `  Read ${formatTokenCount(u.totalCacheRead)}  Write ${formatTokenCount(u.totalCacheWrite)}`,
      `  Input ${formatTokenCount(u.totalInputTokens)}  Output ${formatTokenCount(u.totalOutputTokens)}`,
      "",
      `<b>Pulse</b>  ${pulseOn ? "on" : "off"}`,
      `<b>Workspace</b>  ${diskStr}`,
      `<b>Session</b>   ${info.sessionName ? `"${escapeHtml(info.sessionName)}" ` : ""}${info.sessionId ? "<code>" + escapeHtml(info.sessionId.slice(0, 8)) + "...</code>" : "<i>(new)</i>"} \u00B7 ${sessionAge} old`,
      `<b>Uptime</b>    ${uptime} \u00B7 ${getActiveSessionCount()} active session${getActiveSessionCount() === 1 ? "" : "s"}`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
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
      const projectRoot = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../..",
      );
      const localBin = resolve(projectRoot, "bin/talon.js");

      const trySpawn = (cmd: string, args: string[]): Promise<void> =>
        new Promise((res, rej) => {
          const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
          child.on("error", rej);
          child.on("spawn", () => {
            child.unref();
            res();
          });
        });

      // Try global first, then local bin, then just exit (let process manager restart)
      trySpawn("talon", ["restart"])
        .catch(() => trySpawn(process.execPath, [localBin, "restart"]))
        .catch(() => {})
        .finally(() => process.exit(0));
    }, 500);
  });

  bot.command("plugins", async (ctx) => {
    const plugins = getLoadedPlugins();
    if (plugins.length === 0) {
      await ctx.reply("No plugins loaded.");
      return;
    }
    const lines = plugins.map((p) => {
      const ver = p.plugin.version ? ` v${p.plugin.version}` : "";
      const desc = p.plugin.description ? ` — ${p.plugin.description}` : "";
      const mcp = p.plugin.mcpServerPath ? " [MCP]" : "";
      const fe = p.plugin.frontends?.length
        ? ` (${p.plugin.frontends.join(", ")})`
        : "";
      return `• <b>${escapeHtml(p.plugin.name)}</b>${ver}${mcp}${fe}${desc}`;
    });
    await ctx.reply(
      `<b>Plugins (${plugins.length})</b>\n\n${lines.join("\n")}`,
      { parse_mode: "HTML" },
    );
  });
}
