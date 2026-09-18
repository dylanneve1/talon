/**
 * `/admin stats` / `errors` / `logs` / `daily` — the daemon-health
 * subcommands.
 */

import type { Context } from "grammy";
import { readFileSync } from "node:fs";
import { files, dirs } from "../../../util/paths.js";
import { tailFile } from "../../../util/tail-file.js";
import { escapeHtml } from "../formatting.js";
import { getAllSessions } from "../../../storage/sessions.js";
import { todayLogDate } from "../../../storage/daily-log.js";
import { getActiveCount } from "../../../core/engine/dispatcher.js";
import { getHealthStatus, getRecentErrors } from "../../../util/watchdog.js";
import { formatDuration } from "../../presentation/format.js";

export async function replyStats(ctx: Context): Promise<void> {
  const h = getHealthStatus();
  const sessions = getAllSessions();
  const turns = sessions.reduce((s, x) => s + x.info.turns, 0);
  const mem = process.memoryUsage();
  await ctx.reply(
    [
      `<b>🦅 Talon Stats</b>`,
      "",
      `<b>Uptime:</b> ${formatDuration(h.uptimeMs)}`,
      `<b>Messages:</b> ${h.totalMessagesProcessed}`,
      `<b>Sessions:</b> ${sessions.length}`,
      `<b>Turns:</b> ${turns}`,
      `<b>Last active:</b> ${h.msSinceLastMessage < 60000 ? "now" : formatDuration(h.msSinceLastMessage) + " ago"}`,
      "",
      `<b>Memory:</b> ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB heap / ${(mem.rss / 1024 / 1024).toFixed(1)}MB rss`,
      `<b>Queue:</b> ${getActiveCount()}`,
      `<b>Errors:</b> ${h.recentErrorCount}`,
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}

export async function replyRecentErrors(ctx: Context): Promise<void> {
  const errors = getRecentErrors(5);
  if (errors.length === 0) {
    await ctx.reply("No recent errors.");
    return;
  }
  const lines = errors.map(
    (e) =>
      `<code>[${new Date(e.timestamp).toISOString().slice(11, 19)}]</code> ${escapeHtml(e.message.slice(0, 200))}`,
  );
  await ctx.reply(
    `<b>Recent Errors (${errors.length})</b>\n\n` + lines.join("\n\n"),
    { parse_mode: "HTML" },
  );
}

export async function replyLogTail(ctx: Context): Promise<void> {
  const logPath = files.log;
  try {
    const lines = tailFile(logPath);
    await ctx.reply(`<pre>${escapeHtml(lines.slice(0, 3800))}</pre>`, {
      parse_mode: "HTML",
    });
  } catch {
    await ctx.reply(`Could not read ${logPath}`);
  }
}

export async function replyDailyLog(ctx: Context): Promise<void> {
  const today = todayLogDate();
  const logPath = `${dirs.logs}/${today}.md`;
  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").slice(-30).join("\n");
    await ctx.reply(
      `<b>Daily log (${today})</b>\n\n<pre>${escapeHtml(lines.slice(0, 3800))}</pre>`,
      { parse_mode: "HTML" },
    );
  } catch {
    await ctx.reply(`No daily log for ${today}.`);
  }
}
