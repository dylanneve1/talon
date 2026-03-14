import { Bot } from "grammy";
import { initAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import {
  loadSessions,
  resetSession,
  getSessionInfo,
  getActiveSessionCount,
  flushSessions,
} from "./sessions.js";
import { startBridge, stopBridge } from "./bridge.js";
import { pushMessage, clearHistory } from "./history.js";
import { initUserClient, allowChat } from "./userbot.js";
import { existsSync, mkdirSync } from "node:fs";
import {
  handleTextMessage,
  handlePhotoMessage,
  handleDocumentMessage,
  handleVoiceMessage,
  handleStickerMessage,
  handleVideoMessage,
  handleAnimationMessage,
  handleCallbackQuery,
  getSenderName,
  escapeHtml,
} from "./handlers.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();
loadSessions();
initAgent(config);

const bot = new Bot(config.botToken);

if (!existsSync(config.workspace)) {
  mkdirSync(config.workspace, { recursive: true });
}

// Initialize GramJS user client for full history access (optional)
const apiId = parseInt(process.env.TALON_API_ID || "", 10);
const apiHash = process.env.TALON_API_HASH || "";
if (apiId && apiHash) {
  initUserClient({ apiId, apiHash }).then((ok) => {
    if (ok) console.log("[userbot] Full Telegram history access enabled.");
    else console.log("[userbot] Not authorized. Run: npx tsx src/login.ts");
  }).catch((err) => {
    console.error("[userbot] Init failed:", err instanceof Error ? err.message : err);
  });
} else {
  console.log("[userbot] TALON_API_ID/TALON_API_HASH not set — using in-memory history only.");
}

// ── Commands ─────────────────────────────────────────────────────────────────

bot.command("start", (ctx) =>
  ctx.reply(
    [
      "<b>Talon</b>",
      "",
      "Claude-powered Telegram assistant with 33+ tools.",
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
      "<b>Talon — Help</b>",
      "",
      "<b>Commands</b>",
      "  /status — session info, usage, and stats",
      "  /reset — clear session and start fresh",
      "  /help — this message",
      "",
      "<b>Input</b>",
      "  Text, photos, documents, voice notes, videos, GIFs, stickers, forwarded messages, reply context",
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
      "<b>Groups</b>",
      "  Mention @" + escapeHtml(ctx.me.username ?? "bot") + " or reply to activate.",
      "",
      "<b>Files</b>",
      "  Ask me to create a file and I'll send it as an attachment.",
    ].join("\n"),
    { parse_mode: "HTML" },
  ),
);

bot.command("reset", async (ctx) => {
  const cid = String(ctx.chat.id);
  resetSession(cid);
  clearHistory(cid);
  await ctx.reply("Session cleared.");
});

bot.command("status", async (ctx) => {
  const info = getSessionInfo(String(ctx.chat.id));
  const u = info.usage;
  const uptime = formatDuration(process.uptime() * 1000);
  const sessionAge = info.createdAt ? formatDuration(Date.now() - info.createdAt) : "\u2014";

  // Context usage bar
  const contextMax = 1_000_000;
  const contextUsed = u.lastPromptTokens;
  const contextPct = contextMax > 0 ? Math.min(100, Math.round((contextUsed / contextMax) * 100)) : 0;
  const barLen = 20;
  const filled = Math.round((contextPct / 100) * barLen);
  const contextBar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);

  // Cache hit rate
  const totalPrompt = u.totalInputTokens + u.totalCacheRead + u.totalCacheWrite;
  const cacheHitPct = totalPrompt > 0 ? Math.round((u.totalCacheRead / totalPrompt) * 100) : 0;

  // Response time stats
  const avgResponseMs = info.turns > 0 && u.totalResponseMs ? Math.round(u.totalResponseMs / info.turns) : 0;
  const lastResponseMs = u.lastResponseMs || 0;
  const fastestMs = u.fastestResponseMs || 0;

  const lines = [
    `<b>Talon</b> \u00B7 <code>${escapeHtml(config.model)}</code>`,
    "",
    `<b>Context</b>  ${formatTokenCount(contextUsed)} / ${formatTokenCount(contextMax)} (${contextPct}%)`,
    `<code>${contextBar}</code>`,
    "",
    `<b>Session Stats</b>`,
    `  Response  last ${lastResponseMs ? formatDuration(lastResponseMs) : "\u2014"} \u00B7 avg ${avgResponseMs ? formatDuration(avgResponseMs) : "\u2014"} \u00B7 best ${fastestMs ? formatDuration(fastestMs) : "\u2014"}`,
    `  Turns     ${info.turns}`,
    `  Cost      $${u.estimatedCostUsd.toFixed(4)}`,
    "",
    `<b>Cache</b>     ${cacheHitPct}% hit`,
    `  Read ${formatTokenCount(u.totalCacheRead)}  Write ${formatTokenCount(u.totalCacheWrite)}`,
    `  Input ${formatTokenCount(u.totalInputTokens)}  Output ${formatTokenCount(u.totalOutputTokens)}`,
    "",
    `<b>Session</b>   ${info.sessionId ? "<code>" + escapeHtml(info.sessionId.slice(0, 8)) + "\u2026</code>" : "<i>(new)</i>"} \u00B7 ${sessionAge} old`,
    `<b>Uptime</b>    ${uptime} \u00B7 ${getActiveSessionCount()} active session${getActiveSessionCount() === 1 ? "" : "s"}`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

// ── History capture (runs for ALL messages, before handlers) ─────────────────

bot.on("message", (ctx, next) => {
  const chatId = String(ctx.chat.id);
  const sender = getSenderName(ctx.from);
  const senderId = ctx.from?.id ?? 0;
  const msgId = ctx.message.message_id;
  const replyToMsgId = ctx.message.reply_to_message?.message_id;

  // Register this chat as allowed for userbot access (scope guard)
  allowChat(ctx.chat.id);
  const timestamp = ctx.message.date * 1000;

  if ("text" in ctx.message && ctx.message.text) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.text, replyToMsgId, timestamp });
  } else if ("photo" in ctx.message && ctx.message.photo) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.caption || "(photo)", replyToMsgId, timestamp, mediaType: "photo" });
  } else if ("document" in ctx.message && ctx.message.document) {
    const name = ctx.message.document.file_name || "file";
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.caption || `(sent ${name})`, replyToMsgId, timestamp, mediaType: "document" });
  } else if ("voice" in ctx.message && ctx.message.voice) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: "(voice message)", replyToMsgId, timestamp, mediaType: "voice" });
  } else if ("sticker" in ctx.message && ctx.message.sticker) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.sticker.emoji || "(sticker)", replyToMsgId, timestamp, mediaType: "sticker", stickerFileId: ctx.message.sticker.file_id });
  } else if ("video" in ctx.message && ctx.message.video) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.caption || "(video)", replyToMsgId, timestamp, mediaType: "video" });
  } else if ("animation" in ctx.message && ctx.message.animation) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.caption || "(GIF)", replyToMsgId, timestamp, mediaType: "animation" });
  }

  return next();
});

// ── Message handlers (delegated to handlers.ts) ──────────────────────────────

bot.on("message:text", (ctx) => handleTextMessage(ctx, bot, config));
bot.on("message:photo", (ctx) => handlePhotoMessage(ctx, bot, config));
bot.on("message:document", (ctx) => handleDocumentMessage(ctx, bot, config));
bot.on("message:voice", (ctx) => handleVoiceMessage(ctx, bot, config));
bot.on("message:sticker", (ctx) => handleStickerMessage(ctx, bot, config));
bot.on("message:video", (ctx) => handleVideoMessage(ctx, bot, config));
bot.on("message:animation", (ctx) => handleAnimationMessage(ctx, bot, config));
bot.on("callback_query:data", (ctx) => handleCallbackQuery(ctx, bot, config));

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received, shutting down gracefully...`);
  try {
    await bot.stop();
    console.log("[shutdown] Bot disconnected");
  } catch (err) {
    console.error("[shutdown] Bot stop error:", err instanceof Error ? err.message : err);
  }
  try {
    await stopBridge();
    console.log("[shutdown] Bridge stopped");
  } catch (err) {
    console.error("[shutdown] Bridge stop error:", err instanceof Error ? err.message : err);
  }
  flushSessions();
  console.log("[shutdown] Sessions saved");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  flushSessions();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[warning] Unhandled rejection:", reason instanceof Error ? reason.message : reason);
});

// ── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const bridgePort = await startBridge(19876);
  console.log(`Starting Talon... (bridge port: ${bridgePort})`);

  // Register bot commands with Telegram (clears any stale commands from previous implementations)
  await bot.api.setMyCommands([
    { command: "start", description: "Introduction" },
    { command: "status", description: "Session info, usage, and stats" },
    { command: "reset", description: "Clear session and start fresh" },
    { command: "help", description: "All commands and features" },
  ]);
  console.log("[commands] Registered bot commands with Telegram");

  bot.catch((err) => {
    console.error("Bot error:", err.message ?? err);
  });
  await bot.start({
    onStart: (info) => console.log(`Talon running as @${info.username}`),
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
