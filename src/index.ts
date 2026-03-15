/**
 * Talon — Claude-powered Telegram bot.
 * Entry point: bootstrap, wire modules, start.
 */

import { Bot, InputFile } from "grammy";
import { loadConfig } from "./util/config.js";
import { initWorkspace } from "./util/workspace.js";
import { initAgent } from "./backend/claude-sdk/index.js";
import { loadSessions, flushSessions } from "./storage/sessions.js";
import { loadChatSettings } from "./storage/chat-settings.js";
import {
  startBridge,
  stopBridge,
  setBridgeBotToken,
  setBridgeContext,
  clearBridgeContext,
} from "./frontend/telegram/bridge/server.js";
import {
  initUserClient,
  disconnectUserClient,
} from "./frontend/telegram/userbot.js";
import {
  initPulse,
  startPulseTimer,
  stopPulseTimer,
} from "./core/pulse.js";
import {
  initCron,
  startCronTimer,
  stopCronTimer,
} from "./core/cron.js";
import { loadCronJobs } from "./storage/cron-store.js";
import { startWatchdog, stopWatchdog } from "./util/watchdog.js";
import { registerCommands } from "./frontend/telegram/commands.js";
import { registerMiddleware } from "./frontend/telegram/middleware.js";
import { registerCallbacks } from "./frontend/telegram/callbacks.js";
import { log, logError, logWarn } from "./util/log.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();
initWorkspace(config.workspace);
loadSessions();
loadChatSettings();
loadCronJobs();
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

// ── Register bot handlers ────────────────────────────────────────────────────

registerCommands(bot, config);
registerMiddleware(bot, config);
registerCallbacks(bot, config);

// ── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", `${signal} received, shutting down gracefully...`);
  try { await bot.stop(); log("shutdown", "Bot disconnected"); }
  catch (err) { logError("shutdown", "Bot stop error", err); }
  stopPulseTimer();
  stopCronTimer();
  stopWatchdog();
  try { await disconnectUserClient(); log("shutdown", "User client disconnected"); }
  catch (err) { logError("shutdown", "User client disconnect error", err); }
  try { await stopBridge(); log("shutdown", "Bridge stopped"); }
  catch (err) { logError("shutdown", "Bridge stop error", err); }
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

  await bot.api.deleteMyCommands();
  await bot.api.setMyCommands([
    { command: "start", description: "Introduction" },
    { command: "settings", description: "View and change all chat settings" },
    { command: "status", description: "Session info, usage, and stats" },
    { command: "ping", description: "Health check with latency" },
    { command: "model", description: "Show or change model" },
    { command: "effort", description: "Set thinking effort level" },
    { command: "pulse", description: "Conversation engagement settings" },
    { command: "reset", description: "Clear session and start fresh" },
    { command: "help", description: "All commands and features" },
  ]);
  log("commands", "Registered bot commands with Telegram");

  initPulse({
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
  if (process.env.TALON_PULSE !== "0") {
    startPulseTimer();
  }

  initCron({
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
  startCronTimer();

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
