/**
 * Admin command handlers — /admin subcommands for bot operators.
 */

import type { Bot, Context } from "grammy";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TalonConfig } from "../../util/config.js";
import { escapeHtml } from "./formatting.js";
import {
  resetSession,
  getAllSessions,
} from "../../storage/sessions.js";
import { clearHistory } from "../../storage/history.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { getAllCronJobs, validateCronExpression } from "../../storage/cron-store.js";
import { getActiveCount } from "../../core/dispatcher.js";
import { getPulseStatus } from "../../core/pulse.js";
import { getHealthStatus, getRecentErrors } from "../../util/watchdog.js";
import { formatDuration } from "./helpers.js";

export async function handleAdminCommand(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  const args = (ctx.match as string ?? "").trim();
  const [subcommand, ...rest] = args.split(/\s+/);

  switch (subcommand) {
    case "chats": {
      const sessions = getAllSessions();
      if (sessions.length === 0) { await ctx.reply("No active sessions."); return; }
      sessions.sort((a, b) => (b.info.lastActive || 0) - (a.info.lastActive || 0));

      const titles = new Map<string, string>();
      await Promise.all(sessions.map(async (s) => {
        try {
          const id = parseInt(s.chatId, 10);
          if (isNaN(id)) return;
          const chat = await bot.api.getChat(id);
          titles.set(s.chatId, "title" in chat ? (chat.title ?? "DM") : "first_name" in chat ? (chat.first_name ?? "DM") : "DM");
        } catch { /* inaccessible */ }
      }));

      const lines = sessions.map((s) => {
        const age = s.info.lastActive ? `${Math.round((Date.now() - s.info.lastActive) / 60000)}m ago` : "?";
        const title = titles.get(s.chatId) ?? s.chatId;
        const model = (getChatSettings(s.chatId).model ?? config.model).replace("claude-", "");
        return `<b>${escapeHtml(title)}</b> <code>${s.chatId}</code>\n  ${s.info.turns} turns | ${age} | $${s.info.usage.estimatedCostUsd.toFixed(3)} | ${model}`;
      });
      await ctx.reply(`<b>Active chats (${sessions.length})</b>\n\n` + lines.join("\n\n"), { parse_mode: "HTML" });
      return;
    }

    case "broadcast": {
      const text = rest.join(" ");
      if (!text) { await ctx.reply("Usage: /admin broadcast <text>"); return; }
      const sessions = getAllSessions();
      let sent = 0, failed = 0;
      for (const s of sessions) {
        const id = parseInt(s.chatId, 10);
        if (isNaN(id)) continue;
        try { await bot.api.sendMessage(id, text); sent++; } catch { failed++; }
      }
      await ctx.reply(`Broadcast: ${sent} sent, ${failed} failed (${sessions.length} total).`);
      return;
    }

    case "kill": {
      const target = rest[0];
      if (!target) { await ctx.reply("Usage: /admin kill <chatId>"); return; }
      resetSession(target);
      clearHistory(target);
      await ctx.reply(`Session ${target} reset.`);
      return;
    }

    case "logs": {
      const logPath = resolve(config.workspace, "talon.log");
      try {
        const { statSync, openSync, readSync, closeSync } = await import("node:fs");
        const stat = statSync(logPath);
        const size = Math.min(8192, stat.size);
        const buf = Buffer.alloc(size);
        const fd = openSync(logPath, "r");
        readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
        closeSync(fd);
        const lines = buf.toString("utf-8").trim().split("\n").slice(-20).join("\n");
        await ctx.reply(`<pre>${escapeHtml(lines.slice(0, 3800))}</pre>`, { parse_mode: "HTML" });
      } catch { await ctx.reply(`Could not read ${logPath}`); }
      return;
    }

    case "stats": {
      const h = getHealthStatus();
      const sessions = getAllSessions();
      const cost = sessions.reduce((s, x) => s + x.info.usage.estimatedCostUsd, 0);
      const turns = sessions.reduce((s, x) => s + x.info.turns, 0);
      const mem = process.memoryUsage();
      await ctx.reply([
        `<b>\uD83E\uDD85 Talon Stats</b>`, "",
        `<b>Uptime:</b> ${formatDuration(h.uptimeMs)}`,
        `<b>Messages:</b> ${h.totalMessagesProcessed}`,
        `<b>Sessions:</b> ${sessions.length}`,
        `<b>Turns:</b> ${turns}`,
        `<b>Cost:</b> $${cost.toFixed(4)}`,
        `<b>Last active:</b> ${h.msSinceLastMessage < 60000 ? "now" : formatDuration(h.msSinceLastMessage) + " ago"}`, "",
        `<b>Memory:</b> ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB heap / ${(mem.rss / 1024 / 1024).toFixed(1)}MB rss`,
        `<b>Queue:</b> ${getActiveCount()}`,
        `<b>Errors:</b> ${h.recentErrorCount}`,
      ].join("\n"), { parse_mode: "HTML" });
      return;
    }

    case "errors": {
      const errors = getRecentErrors(5);
      if (errors.length === 0) { await ctx.reply("No recent errors."); return; }
      const lines = errors.map((e) => `<code>[${new Date(e.timestamp).toISOString().slice(11, 19)}]</code> ${escapeHtml(e.message.slice(0, 200))}`);
      await ctx.reply(`<b>Recent Errors (${errors.length})</b>\n\n` + lines.join("\n\n"), { parse_mode: "HTML" });
      return;
    }

    case "cron": {
      const jobs = getAllCronJobs();
      if (jobs.length === 0) { await ctx.reply("No cron jobs."); return; }
      const lines = jobs.map((j) => {
        const v = validateCronExpression(j.schedule, j.timezone);
        const last = j.lastRunAt ? new Date(j.lastRunAt).toISOString().slice(0, 16).replace("T", " ") : "never";
        const next = v.next ? new Date(v.next).toISOString().slice(0, 16).replace("T", " ") : "?";
        return `${j.enabled ? "\u2713" : "\u2717"} <b>${escapeHtml(j.name)}</b>\n  <code>${j.schedule}</code> | ${j.type} | runs: ${j.runCount} | last: ${last} | next: ${next}`;
      });
      await ctx.reply(`<b>Cron Jobs (${jobs.length})</b>\n\n` + lines.join("\n\n"), { parse_mode: "HTML" });
      return;
    }

    case "pulse": {
      const chats = getPulseStatus();
      if (chats.length === 0) { await ctx.reply("No pulse chats."); return; }
      const lines = await Promise.all(chats.map(async (p) => {
        let title = p.chatId;
        try {
          const id = parseInt(p.chatId, 10);
          if (!isNaN(id)) {
            const chat = await bot.api.getChat(id);
            title = "title" in chat ? (chat.title ?? p.chatId) : p.chatId;
          }
        } catch { /* skip */ }
        return `${p.enabled ? "\u2713" : "\u2717"} ${escapeHtml(title)}`;
      }));
      await ctx.reply(`<b>Pulse (${chats.length})</b>\n\n` + lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    case "cost": {
      const sessions = getAllSessions();
      const cost = sessions.reduce((s, x) => s + x.info.usage.estimatedCostUsd, 0);
      const input = sessions.reduce((s, x) => s + x.info.usage.totalInputTokens, 0);
      const output = sessions.reduce((s, x) => s + x.info.usage.totalOutputTokens, 0);
      const cache = sessions.reduce((s, x) => s + x.info.usage.totalCacheRead, 0);
      const turns = sessions.reduce((s, x) => s + x.info.turns, 0);
      const cacheRatio = (input + cache) > 0 ? Math.round((cache / (input + cache)) * 100) : 0;
      await ctx.reply([
        `<b>Cost breakdown</b>`, "",
        `  <b>Total</b>   $${cost.toFixed(4)}`,
        `  <b>Per turn</b> $${turns > 0 ? (cost / turns).toFixed(4) : "0"} avg`,
        `  <b>Turns</b>   ${turns} across ${sessions.length} sessions`, "",
        `  <b>Input</b>   ${(input / 1000).toFixed(1)}K tokens`,
        `  <b>Output</b>  ${(output / 1000).toFixed(1)}K tokens`,
        `  <b>Cache</b>   ${cacheRatio}% hit rate`,
      ].join("\n"), { parse_mode: "HTML" });
      return;
    }

    case "daily": {
      const today = new Date().toISOString().slice(0, 10);
      const logPath = resolve(config.workspace, "logs", `${today}.md`);
      try {
        const content = readFileSync(logPath, "utf-8");
        const lines = content.trim().split("\n").slice(-30).join("\n");
        await ctx.reply(`<b>Daily log (${today})</b>\n\n<pre>${escapeHtml(lines.slice(0, 3800))}</pre>`, { parse_mode: "HTML" });
      } catch { await ctx.reply(`No daily log for ${today}.`); }
      return;
    }

    case "top": {
      const sessions = getAllSessions();
      const sorted = [...sessions].sort((a, b) => b.info.usage.estimatedCostUsd - a.info.usage.estimatedCostUsd).slice(0, 10);
      if (sorted.length === 0) { await ctx.reply("No sessions."); return; }
      const lines = await Promise.all(sorted.map(async (s) => {
        let title = s.chatId;
        try {
          const id = parseInt(s.chatId, 10);
          if (!isNaN(id)) {
            const chat = await bot.api.getChat(id);
            title = "title" in chat ? (chat.title ?? s.chatId) : "first_name" in chat ? (chat.first_name ?? "DM") : s.chatId;
          }
        } catch { /* skip */ }
        return `  $${s.info.usage.estimatedCostUsd.toFixed(4)}  ${escapeHtml(title)}  (${s.info.turns} turns)`;
      }));
      await ctx.reply(`<b>Top ${sorted.length} by cost</b>\n\n` + lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    default:
      await ctx.reply([
        "<b>/admin commands</b>", "",
        "  stats    uptime, messages, cost, memory",
        "  errors   last 5 errors",
        "  chats    list all active chats",
        "  cost     cost breakdown",
        "  daily    today's interaction log",
        "  top      top 10 chats by cost",
        "  pulse    pulse status per chat",
        "  cron     list all cron jobs",
        "  broadcast &lt;text&gt;  send to all chats",
        "  kill &lt;chatId&gt;     reset a chat session",
        "  logs     last 20 lines of log",
      ].join("\n"), { parse_mode: "HTML" });
  }
}
