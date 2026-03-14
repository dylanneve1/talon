import { Bot } from "grammy";
import { initAgent, handleMessage } from "./agent.js";
import { loadConfig } from "./config.js";
import { loadSessions, resetSession, getSessionInfo, getActiveSessionCount } from "./sessions.js";
import { splitMessage, containsTelegramMarkdown } from "./telegram.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();
loadSessions();
initAgent(config);

const bot = new Bot(config.botToken);

// ── Commands ─────────────────────────────────────────────────────────────────

bot.command("start", (ctx) =>
  ctx.reply("Talon here. Send a message or mention me in a group."),
);

bot.command("reset", async (ctx) => {
  resetSession(String(ctx.chat.id));
  await ctx.reply("Session cleared.");
});

bot.command("status", async (ctx) => {
  const info = getSessionInfo(String(ctx.chat.id));
  const uptime = formatDuration(process.uptime() * 1000);
  const lines = [
    "🦅 *Talon*",
    `Model: \`${config.model}\``,
    `Session: ${info.sessionId ? "`" + info.sessionId.slice(0, 8) + "…`" : "_(new)_"}`,
    `Turns: ${info.turns}`,
    `Active sessions: ${getActiveSessionCount()}`,
    `Uptime: ${uptime}`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

// ── Message handler ──────────────────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text;

  // In groups: mention or reply to bot only
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  if (isGroup) {
    const botUser = ctx.me.username;
    const mentioned = botUser && text.toLowerCase().includes(`@${botUser.toLowerCase()}`);
    const repliedToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
    if (!mentioned && !repliedToBot) return;
  }

  const sender =
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "User";

  // Typing indicator — keep alive while processing
  const typing = setInterval(() => {
    ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);
  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  try {
    // Build prompt — include reply context if replying to another user
    let prompt = text;
    const replyMsg = ctx.message.reply_to_message;
    if (replyMsg && replyMsg.from?.id !== ctx.me.id && "text" in replyMsg && replyMsg.text) {
      const replyAuthor = [replyMsg.from?.first_name, replyMsg.from?.last_name]
        .filter(Boolean)
        .join(" ");
      prompt = `[Replying to ${replyAuthor}: "${replyMsg.text.slice(0, 500)}"]\n\n${text}`;
    }

    const result = await handleMessage({ chatId, text: prompt, senderName: sender, isGroup });
    clearInterval(typing);

    if (!result.text) {
      await ctx.reply("_(no response)_", {
        reply_parameters: { message_id: ctx.message.message_id },
        parse_mode: "Markdown",
      });
      return;
    }

    // Send reply chunks
    const chunks = splitMessage(result.text, config.maxMessageLength);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, {
          reply_parameters: { message_id: ctx.message.message_id },
          parse_mode: containsTelegramMarkdown(chunk) ? "Markdown" : undefined,
        });
      } catch {
        // Markdown parse failed — retry without formatting
        await ctx.reply(chunk, {
          reply_parameters: { message_id: ctx.message.message_id },
        });
      }
    }
  } catch (err) {
    clearInterval(typing);
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${chatId}] Error: ${errMsg}`);
    await ctx.reply(
      errMsg.includes("Session expired")
        ? errMsg
        : "Something went wrong. Try /reset if this persists.",
      { reply_parameters: { message_id: ctx.message.message_id } },
    );
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Start ────────────────────────────────────────────────────────────────────

console.log("Starting Talon...");
bot.catch((err) => {
  console.error("Bot error:", err.message ?? err);
});
bot.start({
  onStart: (info) => console.log(`Talon running as @${info.username}`),
});
