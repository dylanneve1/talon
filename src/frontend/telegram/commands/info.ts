/**
 * Informational commands — /start, /help, /ping, /plugins.
 */

import type { Bot } from "grammy";
import { isUserClientReady } from "../userbot.js";
import { escapeHtml } from "../formatting.js";
import { formatDuration } from "../helpers/index.js";
import { getLoadedPlugins } from "../../../core/plugin/index.js";

export function registerInfoCommands(bot: Bot): void {
  bot.command("start", (ctx) =>
    ctx.reply(
      [
        "<b>🦅 Talon</b>",
        "",
        "Agentic AI harness for Telegram.",
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
        "<b>🦅 Talon -- Help</b>",
        "",
        "<b>🦅 Settings</b>",
        "  /settings -- view and change all chat settings",
        "  /model -- show or change model and backend",
        "  /effort -- set thinking effort (off, low, medium, high, max)",
        "  /pulse -- toggle periodic check-ins (on/off)",
        "",
        "<b>Session</b>",
        "  /status -- session info, usage, and stats",
        "  /metrics -- aggregate performance metrics (admin)",
        "  /doctor -- environment and native-module health (admin)",
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

  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const sent = await ctx.reply("...");
    const latency = Date.now() - start;

    const bridgeOk = true;
    const userbotOk = isUserClientReady();
    const uptime = formatDuration(process.uptime() * 1000);

    const statusLine = [
      `Bridge: ${bridgeOk ? "✓" : "✗"}`,
      `Userbot: ${userbotOk ? "✓" : "✗"}`,
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
      {
        parse_mode: "HTML",
      },
    );
  });
}
