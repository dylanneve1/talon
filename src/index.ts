import { Bot, InputFile } from "grammy";
import { initAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import {
  loadSessions,
  resetSession,
  getSessionInfo,
  getActiveSessionCount,
  getAllSessions,
  flushSessions,
  type SessionInfo,
} from "./sessions.js";
import {
  startBridge,
  stopBridge,
  setBridgeBotToken,
  setBridgeContext,
  clearBridgeContext,
} from "./bridge.js";
import { pushMessage, clearHistory } from "./history.js";
import {
  initUserClient,
  allowChat,
  disconnectUserClient,
  isUserClientReady,
} from "./userbot.js";
import {
  loadChatSettings,
  getChatSettings,
  setChatModel,
  setChatEffort,
  setChatProactiveInterval,
  resolveModelName,
  EFFORT_LEVELS,
  type EffortLevel,
} from "./chat-settings.js";
import {
  initProactive,
  registerChatForProactive,
  disableProactive,
  enableProactive,
  isProactiveEnabled,
  startProactiveTimer,
  stopProactiveTimer,
  startPerChatTimer,
  stopPerChatTimer,
  getDefaultIntervalMs,
} from "./proactive.js";
import { readFileSync } from "node:fs";
import { initWorkspace, getWorkspaceDiskUsage } from "./workspace.js";
import {
  startWatchdog,
  stopWatchdog,
  getHealthStatus,
  getRecentErrors,
} from "./watchdog.js";
import {
  handleTextMessage,
  handlePhotoMessage,
  handleDocumentMessage,
  handleVoiceMessage,
  handleStickerMessage,
  handleVideoMessage,
  handleAnimationMessage,
  handleCallbackQuery,
  processAndReply,
  getSenderName,
  escapeHtml,
} from "./handlers.js";
import { appendDailyLog } from "./daily-log.js";
import { log, logError, logWarn } from "./log.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();
initWorkspace(config.workspace);
loadSessions();
loadChatSettings();
initAgent(config);

const bot = new Bot(config.botToken);
setBridgeBotToken(config.botToken);

// Initialize GramJS user client for full history access (optional)
const apiId = parseInt(process.env.TALON_API_ID || "", 10);
const apiHash = process.env.TALON_API_HASH || "";
if (apiId && apiHash) {
  initUserClient({ apiId, apiHash })
    .then((ok) => {
      if (ok) log("userbot", "Full Telegram history access enabled.");
      else log("userbot", "Not authorized. Run: npx tsx src/login.ts");
    })
    .catch((err) => {
      logError("userbot", "Init failed", err);
    });
} else {
  log(
    "userbot",
    "TALON_API_ID/TALON_API_HASH not set -- using in-memory history only.",
  );
}

// ── Commands ─────────────────────────────────────────────────────────────────

bot.command("start", (ctx) =>
  ctx.reply(
    [
      "<b>🦅 Talon</b>",
      "",
      "Claude-powered Telegram assistant with 19 tools.",
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
      "  /model -- show or change model (sonnet, opus, haiku)",
      "  /effort -- set thinking effort (off, low, medium, high, max)",
      "  /proactive -- toggle periodic check-ins (on/off)",
      "",
      "<b>Session</b>",
      "  /status -- session info, usage, and stats",
      "  /ping -- health check with latency",
      "  /reset -- clear session and start fresh",
      "  /help -- this message",
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

  // Log session summary before clearing
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

  const bridgeOk = true; // Bridge is local, always up if bot is running
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
  // Reset session since model change invalidates the SDK session
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

bot.command("proactive", async (ctx) => {
  const cid = String(ctx.chat.id);
  const arg = ctx.match?.trim().toLowerCase();

  if (!arg || arg === "status") {
    const enabled = isProactiveEnabled(cid);
    const chatSets = getChatSettings(cid);
    const intervalMs = chatSets.proactiveIntervalMs ?? getDefaultIntervalMs();
    const intervalStr = formatDuration(intervalMs);
    await ctx.reply(
      `<b>Proactive:</b> ${enabled ? "on" : "off"}\n<b>Interval:</b> ${intervalStr}\nPeriodically checks chat and responds if there's something to add.`,
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
    stopPerChatTimer(cid);
    await ctx.reply("Proactive mode disabled.");
    return;
  }

  // Parse interval: "30m", "2h", "1h30m", "45m"
  const intervalMs = parseInterval(arg);
  if (intervalMs && intervalMs >= 5 * 60 * 1000) {
    // Minimum 5 minutes
    setChatProactiveInterval(cid, intervalMs);
    enableProactive(cid);
    registerChatForProactive(cid);
    startPerChatTimer(cid, intervalMs);
    await ctx.reply(
      `Proactive interval set to <b>${formatDuration(intervalMs)}</b> for this chat.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (intervalMs) {
    await ctx.reply("Minimum interval is 5 minutes.");
    return;
  }

  await ctx.reply(
    "Use: /proactive on, /proactive off, /proactive 30m, /proactive 2h",
  );
});

bot.command("settings", async (ctx) => {
  const cid = String(ctx.chat.id);
  const chatSets = getChatSettings(cid);
  const activeModel = chatSets.model ?? config.model;
  const effortName = chatSets.effort ?? "adaptive";
  const proactiveOn = isProactiveEnabled(cid);

  await ctx.reply(
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
});

// ── Settings panel helpers ───────────────────────────────────────────────────

function renderSettingsText(
  model: string,
  effort: string,
  proactive: boolean,
  proactiveIntervalMs?: number,
): string {
  const intervalStr = proactiveIntervalMs
    ? formatDuration(proactiveIntervalMs)
    : formatDuration(getDefaultIntervalMs());
  return [
    "<b>🦅 Settings</b>",
    "",
    `<b>Model:</b> <code>${escapeHtml(model)}</code>`,
    `<b>Effort:</b> ${effort}`,
    `<b>Proactive:</b> ${proactive ? "on" : "off"} (every ${intervalStr})`,
  ].join("\n");
}

function renderSettingsKeyboard(
  model: string,
  effort: string,
  proactive: boolean,
): Array<Array<{ text: string; callback_data: string }>> {
  const isModel = (id: string) => model.includes(id);
  return [
    [
      {
        text: isModel("sonnet") ? "\u2713 Sonnet" : "Sonnet",
        callback_data: "settings:model:sonnet",
      },
      {
        text: isModel("opus") ? "\u2713 Opus" : "Opus",
        callback_data: "settings:model:opus",
      },
      {
        text: isModel("haiku") ? "\u2713 Haiku" : "Haiku",
        callback_data: "settings:model:haiku",
      },
    ],
    [
      {
        text: effort === "low" ? "\u2713 Low" : "Low",
        callback_data: "settings:effort:low",
      },
      {
        text: effort === "medium" ? "\u2713 Med" : "Med",
        callback_data: "settings:effort:medium",
      },
      {
        text: effort === "high" ? "\u2713 High" : "High",
        callback_data: "settings:effort:high",
      },
      {
        text: effort === "adaptive" ? "\u2713 Auto" : "Auto",
        callback_data: "settings:effort:adaptive",
      },
    ],
    [
      {
        text: proactive ? "Proactive: ON" : "Proactive: OFF",
        callback_data: `settings:proactive:${proactive ? "off" : "on"}`,
      },
      { text: "Done", callback_data: "settings:done" },
    ],
  ];
}

// ── Admin commands (Dylan only, user_id 352042062) ──────────────────────────

const ADMIN_USER_ID = 352042062;

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
      // Sort by last active (most recent first)
      sessions.sort(
        (a, b) => (b.info.lastActive || 0) - (a.info.lastActive || 0),
      );

      // Fetch chat titles in parallel
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
      for (const s of sessions) {
        const numericId = parseInt(s.chatId, 10);
        if (isNaN(numericId)) continue;
        try {
          await bot.api.sendMessage(numericId, text);
          sent++;
        } catch {
          // Chat might have blocked the bot
        }
      }
      await ctx.reply(`Broadcast sent to ${sent}/${sessions.length} chats.`);
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
      try {
        const logContent = readFileSync("/tmp/talon.log", "utf-8");
        const lines = logContent.trim().split("\n");
        const last20 = lines.slice(-20).join("\n");
        await ctx.reply(`<pre>${escapeHtml(last20.slice(0, 3800))}</pre>`, {
          parse_mode: "HTML",
        });
      } catch {
        await ctx.reply("Could not read /tmp/talon.log");
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
        "<b>🦅 Talon Stats</b>",
        "",
        `<b>Uptime:</b> ${uptime}`,
        `<b>Messages processed:</b> ${health.totalMessagesProcessed}`,
        `<b>Active sessions:</b> ${sessions.length}`,
        `<b>Total turns:</b> ${totalTurns}`,
        `<b>Total cost:</b> $${totalCost.toFixed(4)}`,
        `<b>Last message:</b> ${health.msSinceLastMessage < 60000 ? "just now" : formatDuration(health.msSinceLastMessage) + " ago"}`,
        "",
        `<b>Memory:</b> heap ${heapMB}MB / rss ${rssMB}MB`,
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

    default:
      await ctx.reply(
        "<b>/admin commands</b>\n\n" +
          "  /admin stats -- uptime, messages, cost, memory\n" +
          "  /admin errors -- last 5 errors\n" +
          "  /admin chats -- list all active chats\n" +
          "  /admin broadcast &lt;text&gt; -- send to all chats\n" +
          "  /admin kill &lt;chatId&gt; -- reset a chat session\n" +
          "  /admin logs -- last 20 lines of /tmp/talon.log",
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
  const proactiveOn = isProactiveEnabled(cid);

  // Context window size depends on model
  const contextMax = activeModel.includes("haiku") ? 200_000 : 1_000_000;
  const contextUsed = u.lastPromptTokens;
  const contextPct =
    contextMax > 0
      ? Math.min(100, Math.round((contextUsed / contextMax) * 100))
      : 0;
  const barLen = 20;
  const filled = Math.round((contextPct / 100) * barLen);
  const contextBar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);

  // Cache hit rate
  const totalPrompt = u.totalInputTokens + u.totalCacheRead + u.totalCacheWrite;
  const cacheHitPct =
    totalPrompt > 0 ? Math.round((u.totalCacheRead / totalPrompt) * 100) : 0;

  // Response time stats
  const avgResponseMs =
    info.turns > 0 && u.totalResponseMs
      ? Math.round(u.totalResponseMs / info.turns)
      : 0;
  const lastResponseMs = u.lastResponseMs || 0;
  const fastestMs = u.fastestResponseMs || 0;

  // Workspace disk usage
  const diskBytes = getWorkspaceDiskUsage(config.workspace);
  const diskStr = formatBytes(diskBytes);

  const lines = [
    `<b>🦅 Talon</b> \u00B7 <code>${escapeHtml(activeModel)}</code> \u00B7 effort: ${effortName}`,
    "",
    `<b>Context</b>  ${formatTokenCount(contextUsed)} / ${formatTokenCount(contextMax)} (${contextPct}%)`,
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
    `<b>Proactive</b>  ${proactiveOn ? "on" : "off"}`,
    `<b>Workspace</b>  ${diskStr}`,
    `<b>Session</b>   ${info.sessionName ? `"${escapeHtml(info.sessionName)}" ` : ""}${info.sessionId ? "<code>" + escapeHtml(info.sessionId.slice(0, 8)) + "...</code>" : "<i>(new)</i>"} \u00B7 ${sessionAge} old`,
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
    pushMessage(chatId, {
      msgId,
      senderId,
      senderName: sender,
      text: ctx.message.text,
      replyToMsgId,
      timestamp,
    });
  } else if ("photo" in ctx.message && ctx.message.photo) {
    pushMessage(chatId, {
      msgId,
      senderId,
      senderName: sender,
      text: ctx.message.caption || "(photo)",
      replyToMsgId,
      timestamp,
      mediaType: "photo",
    });
  } else if ("document" in ctx.message && ctx.message.document) {
    const name = ctx.message.document.file_name || "file";
    pushMessage(chatId, {
      msgId,
      senderId,
      senderName: sender,
      text: ctx.message.caption || `(sent ${name})`,
      replyToMsgId,
      timestamp,
      mediaType: "document",
    });
  } else if ("voice" in ctx.message && ctx.message.voice) {
    pushMessage(chatId, {
      msgId,
      senderId,
      senderName: sender,
      text: "(voice message)",
      replyToMsgId,
      timestamp,
      mediaType: "voice",
    });
  } else if ("sticker" in ctx.message && ctx.message.sticker) {
    pushMessage(chatId, {
      msgId,
      senderId,
      senderName: sender,
      text: ctx.message.sticker.emoji || "(sticker)",
      replyToMsgId,
      timestamp,
      mediaType: "sticker",
      stickerFileId: ctx.message.sticker.file_id,
    });
  } else if ("video" in ctx.message && ctx.message.video) {
    pushMessage(chatId, {
      msgId,
      senderId,
      senderName: sender,
      text: ctx.message.caption || "(video)",
      replyToMsgId,
      timestamp,
      mediaType: "video",
    });
  } else if ("animation" in ctx.message && ctx.message.animation) {
    pushMessage(chatId, {
      msgId,
      senderId,
      senderName: sender,
      text: ctx.message.caption || "(GIF)",
      replyToMsgId,
      timestamp,
      mediaType: "animation",
    });
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

// ── Edited message handler ──────────────────────────────────────────────────

bot.on("edited_message:text", async (ctx) => {
  if (!ctx.editedMessage || !ctx.chat) return;
  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";

  // In groups, only handle if bot is mentioned or replied to
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

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const cid = String(ctx.chat?.id ?? ctx.from.id);

  // Handle unified /settings callbacks
  if (data.startsWith("settings:")) {
    const parts = data.split(":");
    const category = parts[1];
    const value = parts[2];

    // Handle "Done" button -- delete the settings message
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

    // Re-render the settings panel
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

  // Handle settings callbacks directly
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

  if (data.startsWith("effort:")) {
    const level = data.slice(7);
    if (level === "adaptive") {
      setChatEffort(cid, undefined);
      await ctx.answerCallbackQuery({ text: "Effort: adaptive" });
    } else if (EFFORT_LEVELS.includes(level as EffortLevel)) {
      setChatEffort(cid, level as EffortLevel);
      await ctx.answerCallbackQuery({ text: `Effort: ${level}` });
    }
    // Update the inline keyboard to show selection
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a duration string like "30m", "2h", "1h30m" into milliseconds. */
function parseInterval(input: string): number | null {
  const match = input.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match || (!match[1] && !match[2])) return null;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const ms = (hours * 60 + minutes) * 60 * 1000;
  return ms > 0 ? ms : null;
}

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

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", `${signal} received, shutting down gracefully...`);
  try {
    await bot.stop();
    log("shutdown", "Bot disconnected");
  } catch (err) {
    logError("shutdown", "Bot stop error", err);
  }
  stopProactiveTimer();
  stopWatchdog();
  try {
    await disconnectUserClient();
    log("shutdown", "User client disconnected");
  } catch (err) {
    logError("shutdown", "User client disconnect error", err);
  }
  try {
    await stopBridge();
    log("shutdown", "Bridge stopped");
  } catch (err) {
    logError("shutdown", "Bridge stop error", err);
  }
  flushSessions();
  log("shutdown", "Sessions saved");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logError("bot", "Uncaught exception", err);
  flushSessions();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logWarn(
    "bot",
    `Unhandled rejection: ${reason instanceof Error ? reason.message : reason}`,
  );
});

// ── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const bridgePort = await startBridge(19876);
  log("bot", `Starting Talon... (bridge port: ${bridgePort})`);

  // Register bot commands with Telegram
  await bot.api.deleteMyCommands();
  await bot.api.setMyCommands([
    { command: "start", description: "Introduction" },
    { command: "settings", description: "View and change all chat settings" },
    { command: "status", description: "Session info, usage, and stats" },
    { command: "ping", description: "Health check with latency" },
    { command: "model", description: "Show or change model" },
    { command: "effort", description: "Set thinking effort level" },
    { command: "proactive", description: "Toggle proactive check-ins" },
    { command: "reset", description: "Clear session and start fresh" },
    { command: "help", description: "All commands and features" },
  ]);
  log("commands", "Registered bot commands with Telegram");

  // Initialize proactive engagement
  initProactive({
    config,
    setBridgeContext: setBridgeContext as (
      chatId: number,
      bot: unknown,
      inputFile: unknown,
    ) => void,
    clearBridgeContext,
    bot,
    inputFile: InputFile,
  });
  if (process.env.TALON_PROACTIVE !== "0") {
    startProactiveTimer();
  }

  // Start health monitoring
  startWatchdog();

  bot.catch((err) => {
    logError("bot", "Unhandled bot error", err);
  });
  await bot.start({
    onStart: (info) => log("bot", `Talon running as @${info.username}`),
  });
}

main().catch((err) => {
  logError("bot", "Fatal startup error", err);
  process.exit(1);
});
