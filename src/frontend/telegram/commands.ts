/**
 * All /command handlers for the Telegram bot.
 */

import type { Bot } from "grammy";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TalonConfig } from "../../util/config.js";
import {
  resetSession,
  getSessionInfo,
  getActiveSessionCount,
  getAllSessions,
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
  getPulseStatus,
} from "../../core/pulse.js";
import { isUserClientReady } from "./userbot.js";
import { getWorkspaceDiskUsage } from "../../util/workspace.js";
import { getQueueSize } from "../../core/dispatcher.js";
import {
  getHealthStatus,
  getRecentErrors,
} from "../../util/watchdog.js";
import { appendDailyLog } from "../../storage/daily-log.js";
import { getAllCronJobs, validateCronExpression } from "../../storage/cron-store.js";
import { escapeHtml } from "./formatting.js";
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
        "Claude-powered Telegram assistant with 29 tools.",
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
        "  /ping -- health check with latency",
        "  /reset -- clear session and start fresh",
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
        "  Share a URL and Talon automatically reads the page. Ask to summarize, analyze, or discuss.",
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
        `Session reset${nameNote}: ${info.turns} turns, ${duration}, $${info.usage.estimatedCostUsd.toFixed(4)}${modelNote}`,
      );
    }

    resetSession(cid);
    clearHistory(cid);
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
    resetSession(cid);
    await ctx.reply(
      `Model set to <code>${escapeHtml(model)}</code>. Session reset.`,
      { parse_mode: "HTML" },
    );
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
            inline_keyboard: [[
              { text: enabled ? "✓ On" : "On", callback_data: "pulse:on" },
              { text: !enabled ? "✓ Off" : "Off", callback_data: "pulse:off" },
            ]],
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

    await ctx.reply(
      "Use: /pulse on, /pulse off, /pulse 30m, /pulse 2h",
    );
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

    const args = (ctx.match ?? "").trim();
    const [subcommand, ...rest] = args.split(/\s+/);

    switch (subcommand) {
      case "chats": {
        const sessions = getAllSessions();
        if (sessions.length === 0) {
          await ctx.reply("No active sessions.");
          return;
        }
        sessions.sort(
          (a, b) => (b.info.lastActive || 0) - (a.info.lastActive || 0),
        );

        const chatTitles = new Map<string, string>();
        await Promise.all(
          sessions.map(async (s) => {
            try {
              const numId = parseInt(s.chatId, 10);
              if (isNaN(numId)) return;
              const chat = await bot.api.getChat(numId);
              const title =
                "title" in chat
                  ? chat.title
                  : "first_name" in chat
                    ? (chat.first_name ?? "DM")
                    : "DM";
              chatTitles.set(s.chatId, title ?? "Unknown");
            } catch {
              // Chat might be inaccessible
            }
          }),
        );

        const lines = sessions.map((s) => {
          const age = s.info.lastActive
            ? `${Math.round((Date.now() - s.info.lastActive) / 60000)}m ago`
            : "unknown";
          const title = chatTitles.get(s.chatId) ?? s.chatId;
          const chatSettings = getChatSettings(s.chatId);
          const model = (
            chatSettings.model ??
            config.model ??
            "sonnet"
          ).replace("claude-", "");
          const effort = chatSettings.effort ?? "adaptive";
          return (
            `<b>${escapeHtml(title)}</b> <code>${s.chatId}</code>\n` +
            `  ${s.info.turns} turns | ${age} | $${s.info.usage.estimatedCostUsd.toFixed(3)} | ${model} | effort: ${effort}`
          );
        });
        await ctx.reply(
          `<b>Active chats (${sessions.length})</b>\n\n` + lines.join("\n\n"),
          { parse_mode: "HTML" },
        );
        return;
      }

      case "broadcast": {
        const text = rest.join(" ");
        if (!text) {
          await ctx.reply("Usage: /admin broadcast <text>");
          return;
        }
        const sessions = getAllSessions();
        let sent = 0;
        let failed = 0;
        for (const s of sessions) {
          const numericId = parseInt(s.chatId, 10);
          if (isNaN(numericId)) continue;
          try {
            await bot.api.sendMessage(numericId, text);
            sent++;
          } catch {
            failed++;
          }
        }
        await ctx.reply(`Broadcast: ${sent} sent, ${failed} failed (${sessions.length} total).`);
        return;
      }

      case "kill": {
        const targetChatId = rest[0];
        if (!targetChatId) {
          await ctx.reply("Usage: /admin kill <chatId>");
          return;
        }
        resetSession(targetChatId);
        clearHistory(targetChatId);
        await ctx.reply(`Session for chat ${targetChatId} has been reset.`);
        return;
      }

      case "logs": {
        const logPath = resolve(config.workspace, "talon.log");
        try {
          // Read only the last 8KB to avoid OOM on large log files
          const { statSync, openSync, readSync, closeSync } = await import("node:fs");
          const stat = statSync(logPath);
          const readSize = Math.min(8192, stat.size);
          const buf = Buffer.alloc(readSize);
          const fd = openSync(logPath, "r");
          readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
          closeSync(fd);
          const tail = buf.toString("utf-8");
          const lines = tail.trim().split("\n").slice(-20).join("\n");
          await ctx.reply(`<pre>${escapeHtml(lines.slice(0, 3800))}</pre>`, {
            parse_mode: "HTML",
          });
        } catch {
          await ctx.reply(`Could not read ${logPath}`);
        }
        return;
      }

      case "stats": {
        const health = getHealthStatus();
        const uptime = formatDuration(health.uptimeMs);
        const sessions = getAllSessions();
        const totalCost = sessions.reduce(
          (sum, s) => sum + s.info.usage.estimatedCostUsd,
          0,
        );
        const totalTurns = sessions.reduce((sum, s) => sum + s.info.turns, 0);
        const memUsage = process.memoryUsage();
        const heapMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
        const rssMB = (memUsage.rss / 1024 / 1024).toFixed(1);

        const lines = [
          "<b>\uD83E\uDD85 Talon Stats</b>",
          "",
          `<b>Uptime:</b> ${uptime}`,
          `<b>Messages processed:</b> ${health.totalMessagesProcessed}`,
          `<b>Active sessions:</b> ${sessions.length}`,
          `<b>Total turns:</b> ${totalTurns}`,
          `<b>Total cost:</b> $${totalCost.toFixed(4)}`,
          `<b>Last message:</b> ${health.msSinceLastMessage < 60000 ? "just now" : formatDuration(health.msSinceLastMessage) + " ago"}`,
          "",
          `<b>Memory:</b> heap ${heapMB}MB / rss ${rssMB}MB`,
          `<b>Queue:</b> ${getQueueSize()} pending`,
          `<b>Recent errors:</b> ${health.recentErrorCount}`,
        ];
        await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
        return;
      }

      case "errors": {
        const errors = getRecentErrors(5);
        if (errors.length === 0) {
          await ctx.reply("No recent errors.");
          return;
        }
        const lines = errors.map((e) => {
          const time = new Date(e.timestamp).toISOString().slice(11, 19);
          return `<code>[${time}]</code> ${escapeHtml(e.message.slice(0, 200))}`;
        });
        await ctx.reply(
          `<b>Recent Errors (${errors.length})</b>\n\n` + lines.join("\n\n"),
          { parse_mode: "HTML" },
        );
        return;
      }

      case "cron": {
        const cronJobs = getAllCronJobs();
        if (cronJobs.length === 0) {
          await ctx.reply("No cron jobs configured.");
          return;
        }

        const lines = cronJobs.map((j) => {
          const status = j.enabled ? "\u2713" : "\u2717";
          const lastRun = j.lastRunAt
            ? new Date(j.lastRunAt).toISOString().slice(0, 16).replace("T", " ")
            : "never";
          const validation = validateCronExpression(j.schedule, j.timezone);
          const nextRun = validation.next
            ? new Date(validation.next).toISOString().slice(0, 16).replace("T", " ")
            : "?";
          return (
            `${status} <b>${escapeHtml(j.name)}</b>\n` +
            `  Chat: <code>${j.chatId}</code>\n` +
            `  Schedule: <code>${escapeHtml(j.schedule)}</code>${j.timezone ? ` (${escapeHtml(j.timezone)})` : ""}\n` +
            `  Type: ${j.type} | Runs: ${j.runCount} | Last: ${lastRun}\n` +
            `  Next: ${nextRun}\n` +
            `  ID: <code>${j.id}</code>`
          );
        });
        await ctx.reply(
          `<b>Cron Jobs (${cronJobs.length})</b>\n\n` + lines.join("\n\n"),
          { parse_mode: "HTML" },
        );
        return;
      }

      case "pulse": {
        const pulseChats = getPulseStatus();
        if (pulseChats.length === 0) {
          await ctx.reply("No chats registered for pulse.");
          return;
        }
        const lines = await Promise.all(pulseChats.map(async (p) => {
          let title = p.chatId;
          try {
            const numId = parseInt(p.chatId, 10);
            if (!isNaN(numId)) {
              const chat = await bot.api.getChat(numId);
              title = "title" in chat ? (chat.title ?? p.chatId) : p.chatId;
            }
          } catch { /* inaccessible */ }
          const status = p.enabled ? "\u2713" : "\u2717";
          const lastCheck = p.lastChecked ? `msg:${p.lastChecked}` : "never";
          return `${status} ${escapeHtml(title)} (${lastCheck})`;
        }));
        await ctx.reply(
          `<b>Pulse (${pulseChats.length} chats)</b>\n\n` + lines.join("\n"),
          { parse_mode: "HTML" },
        );
        return;
      }

      case "daily": {
        const today = new Date().toISOString().slice(0, 10);
        const logPath = resolve(config.workspace, "logs", `${today}.md`);
        try {
          const content = readFileSync(logPath, "utf-8");
          const lines = content.trim().split("\n").slice(-30).join("\n");
          await ctx.reply(`<b>Daily log (${today})</b>\n\n<pre>${escapeHtml(lines.slice(0, 3800))}</pre>`, {
            parse_mode: "HTML",
          });
        } catch {
          await ctx.reply(`No daily log for ${today}.`);
        }
        return;
      }

      case "top": {
        const sessions = getAllSessions();
        const sorted = [...sessions]
          .sort((a, b) => b.info.usage.estimatedCostUsd - a.info.usage.estimatedCostUsd)
          .slice(0, 10);
        if (sorted.length === 0) {
          await ctx.reply("No sessions yet.");
          return;
        }
        const lines = await Promise.all(sorted.map(async (s) => {
          let title = s.chatId;
          try {
            const numId = parseInt(s.chatId, 10);
            if (!isNaN(numId)) {
              const chat = await bot.api.getChat(numId);
              title = "title" in chat ? (chat.title ?? s.chatId) : "first_name" in chat ? (chat.first_name ?? "DM") : s.chatId;
            }
          } catch { /* inaccessible */ }
          return `  $${s.info.usage.estimatedCostUsd.toFixed(4)}  ${escapeHtml(title)}  (${s.info.turns} turns)`;
        }));
        await ctx.reply(
          `<b>Top ${sorted.length} by cost</b>\n\n` + lines.join("\n"),
          { parse_mode: "HTML" },
        );
        return;
      }

      default:
        await ctx.reply(
          "<b>/admin commands</b>\n\n" +
            "  /admin stats -- uptime, messages, cost, memory\n" +
            "  /admin errors -- last 5 errors\n" +
            "  /admin chats -- list all active chats\n" +
            "  /admin daily -- today's interaction log\n" +
            "  /admin top -- top 10 chats by cost\n" +
            "  /admin broadcast &lt;text&gt; -- send to all chats\n" +
            "  /admin kill &lt;chatId&gt; -- reset a chat session\n" +
            "  /admin pulse -- pulse status per chat\n" +
            "  /admin logs -- last 20 lines of log\n" +
            "  /admin cron -- list all cron jobs",
          { parse_mode: "HTML" },
        );
    }
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
    const contextBar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
    const contextWarn = contextPct >= 80 ? " \u26A0\uFE0F consider /reset" : "";

    const totalPrompt = u.totalInputTokens + u.totalCacheRead + u.totalCacheWrite;
    const cacheHitPct =
      totalPrompt > 0 ? Math.round((u.totalCacheRead / totalPrompt) * 100) : 0;

    const avgResponseMs =
      info.turns > 0 && u.totalResponseMs
        ? Math.round(u.totalResponseMs / info.turns)
        : 0;
    const lastResponseMs = u.lastResponseMs || 0;
    const fastestMs = u.fastestResponseMs === Infinity ? 0 : (u.fastestResponseMs || 0);

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
      `  Turns     ${info.turns}`,
      `  Cost      $${u.estimatedCostUsd.toFixed(4)}${info.lastModel ? ` (${info.lastModel.replace("claude-", "")})` : ""}`,
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
}
