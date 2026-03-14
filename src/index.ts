import { Bot, InputFile } from "grammy";
import { initAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import {
  loadSessions,
  resetSession,
  getSessionInfo,
  getActiveSessionCount,
  flushSessions,
} from "./sessions.js";
import { startBridge, stopBridge, setBridgeContext, clearBridgeContext } from "./bridge.js";
import { pushMessage, clearHistory } from "./history.js";
import { initUserClient, allowChat } from "./userbot.js";
import {
  loadChatSettings,
  getChatSettings,
  setChatModel,
  setChatThinking,
  resolveModelName,
  THINKING_PRESETS,
} from "./chat-settings.js";
import {
  initProactive,
  registerChatForProactive,
  disableProactive,
  enableProactive,
  isProactiveEnabled,
  startProactiveTimer,
  stopProactiveTimer,
} from "./proactive.js";
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
loadChatSettings();
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
      "  /model — show or change model (sonnet, opus, haiku)",
      "  /effort — set thinking effort (off, low, medium, high, max)",
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

bot.command("model", async (ctx) => {
  const cid = String(ctx.chat.id);
  const arg = ctx.match?.trim();
  const settings = getChatSettings(cid);

  if (!arg) {
    const current = settings.model ?? config.model;
    await ctx.reply(
      [
        `<b>Current model:</b> <code>${escapeHtml(current)}</code>`,
        settings.model ? "(per-chat override)" : "(global default)",
        "",
        "<b>Usage:</b> <code>/model sonnet</code>",
        "",
        "<b>Available:</b>",
        "  <code>sonnet</code> — claude-sonnet-4-6",
        "  <code>opus</code> — claude-opus-4-6",
        "  <code>haiku</code> — claude-haiku-4-5",
        "  Or any full model ID",
        "",
        "<code>/model reset</code> — use global default",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    return;
  }

  if (arg === "reset" || arg === "default") {
    setChatModel(cid, undefined);
    await ctx.reply(`Model reset to default: <code>${escapeHtml(config.model)}</code>`, { parse_mode: "HTML" });
    return;
  }

  const model = resolveModelName(arg);
  setChatModel(cid, model);
  // Reset session since model change invalidates the SDK session
  resetSession(cid);
  await ctx.reply(`Model set to <code>${escapeHtml(model)}</code>. Session reset.`, { parse_mode: "HTML" });
});

bot.command("effort", async (ctx) => {
  const cid = String(ctx.chat.id);
  const arg = ctx.match?.trim().toLowerCase();
  const settings = getChatSettings(cid);

  if (!arg) {
    const current = settings.maxThinkingTokens ?? config.maxThinkingTokens;
    const presetName = Object.entries(THINKING_PRESETS).find(([, v]) => v === current)?.[0] ?? "custom";
    await ctx.reply(
      [
        `<b>Current effort:</b> ${presetName} (${current.toLocaleString()} thinking tokens)`,
        settings.maxThinkingTokens !== undefined ? "(per-chat override)" : "(global default)",
        "",
        "<b>Usage:</b> <code>/effort high</code>",
        "",
        "<b>Presets:</b>",
        "  <code>off</code> — no thinking (fastest)",
        "  <code>low</code> — 2k tokens",
        "  <code>medium</code> — 8k tokens",
        "  <code>high</code> — 16k tokens",
        "  <code>max</code> — 32k tokens",
        "",
        "<code>/effort reset</code> — use global default",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    return;
  }

  if (arg === "reset" || arg === "default") {
    setChatThinking(cid, undefined);
    const defaultPreset = Object.entries(THINKING_PRESETS).find(([, v]) => v === config.maxThinkingTokens)?.[0] ?? "custom";
    await ctx.reply(`Effort reset to default: ${defaultPreset} (${config.maxThinkingTokens.toLocaleString()} tokens)`, { parse_mode: "HTML" });
    return;
  }

  const preset = THINKING_PRESETS[arg];
  if (preset !== undefined) {
    setChatThinking(cid, preset);
    await ctx.reply(`Effort set to <b>${arg}</b> (${preset.toLocaleString()} thinking tokens)`, { parse_mode: "HTML" });
    return;
  }

  const num = parseInt(arg, 10);
  if (!isNaN(num) && num >= 0 && num <= 128000) {
    setChatThinking(cid, num);
    await ctx.reply(`Thinking tokens set to ${num.toLocaleString()}`, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply("Unknown preset. Use: off, low, medium, high, max, or a number (0-128000).");
});

bot.command("proactive", async (ctx) => {
  const cid = String(ctx.chat.id);
  const arg = ctx.match?.trim().toLowerCase();

  if (!arg || arg === "status") {
    const enabled = isProactiveEnabled(cid);
    await ctx.reply(
      `Proactive mode: <b>${enabled ? "on" : "off"}</b>\n\nWhen on, I'll periodically check the chat and respond if I have something to add.\n\n<code>/proactive on</code> · <code>/proactive off</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (arg === "on" || arg === "enable") {
    enableProactive(cid);
    registerChatForProactive(cid);
    await ctx.reply("Proactive mode enabled. I'll check in periodically.");
    return;
  }

  if (arg === "off" || arg === "disable") {
    disableProactive(cid);
    await ctx.reply("Proactive mode disabled.");
    return;
  }

  await ctx.reply("Use: /proactive on, /proactive off, or /proactive status");
});

bot.command("status", async (ctx) => {
  const cid = String(ctx.chat.id);
  const info = getSessionInfo(cid);
  const u = info.usage;
  const uptime = formatDuration(process.uptime() * 1000);
  const sessionAge = info.createdAt ? formatDuration(Date.now() - info.createdAt) : "\u2014";
  const chatSets = getChatSettings(cid);
  const activeModel = chatSets.model ?? config.model;
  const activeThinking = chatSets.maxThinkingTokens ?? config.maxThinkingTokens;
  const effortName = Object.entries(THINKING_PRESETS).find(([, v]) => v === activeThinking)?.[0] ?? `${activeThinking}`;

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
    `<b>Talon</b> \u00B7 <code>${escapeHtml(activeModel)}</code> \u00B7 effort: ${effortName}`,
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

  // Register this chat for userbot + proactive access
  allowChat(ctx.chat.id);
  registerChatForProactive(chatId);
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
  stopProactiveTimer();
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
    { command: "model", description: "Show or change model" },
    { command: "effort", description: "Set thinking effort level" },
    { command: "reset", description: "Clear session and start fresh" },
    { command: "help", description: "All commands and features" },
  ]);
  console.log("[commands] Registered bot commands with Telegram");

  // Initialize proactive engagement
  initProactive({
    config,
    setBridgeContext: setBridgeContext as (chatId: number, bot: unknown, inputFile: unknown) => void,
    clearBridgeContext,
    bot,
    inputFile: InputFile,
  });
  if (process.env.TALON_PROACTIVE !== "0") {
    startProactiveTimer();
  }

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
