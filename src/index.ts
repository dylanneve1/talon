/**
 * Talon — agentic AI harness.
 * Composition root: loads config, creates frontend + backend, wires dispatcher.
 *
 * Frontends (Telegram, Terminal) and backends (Claude, OpenCode)
 * are loaded dynamically — only the selected platform's dependencies are required.
 */

import { loadConfig, getFrontends, rebuildSystemPrompt } from "./util/config.js";
import { initWorkspace, startUploadCleanup, stopUploadCleanup } from "./util/workspace.js";
import { loadSessions, flushSessions } from "./storage/sessions.js";
import { loadChatSettings, flushChatSettings } from "./storage/chat-settings.js";
import { loadCronJobs, flushCronJobs } from "./storage/cron-store.js";
import { loadHistory, flushHistory } from "./storage/history.js";
import { loadMediaIndex, flushMediaIndex } from "./storage/media-index.js";
import { cleanupOldLogs } from "./storage/daily-log.js";
import { initDispatcher, getQueueSize } from "./core/dispatcher.js";
import {
  initPulse,
  startPulseTimer,
  stopPulseTimer,
  resetPulseTimer,
} from "./core/pulse.js";
import {
  initCron,
  startCronTimer,
  stopCronTimer,
} from "./core/cron.js";
import { startWatchdog, stopWatchdog } from "./util/watchdog.js";
import { log, logError, logWarn } from "./util/log.js";
import type { QueryBackend, ContextManager } from "./core/types.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();

// Expose search config as env vars for gateway-actions
if (config.braveApiKey) process.env.TALON_BRAVE_API_KEY = config.braveApiKey;
if (config.searxngUrl) process.env.TALON_SEARXNG_URL = config.searxngUrl;

// Load plugins (external tool packages)
if (config.plugins.length > 0) {
  const { loadPlugins, getPluginPromptAdditions } = await import("./core/plugin.js");
  await loadPlugins(config.plugins);
  rebuildSystemPrompt(config, getPluginPromptAdditions());
}

initWorkspace(config.workspace);
loadSessions();
loadChatSettings();
loadCronJobs();
loadHistory();
loadMediaIndex();
cleanupOldLogs();

// ── Create frontend (dynamic import — only selected platform's deps required) ─

type Frontend = {
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

const selectedFrontend = getFrontends(config)[0]; // use first configured frontend
let frontend: Frontend;

if (selectedFrontend === "terminal") {
  const { createTerminalFrontend } = await import("./frontend/terminal/index.js");
  frontend = createTerminalFrontend(config);
  log("bot", "Frontend: Terminal");
} else {
  const { createTelegramFrontend } = await import("./frontend/telegram/index.js");
  frontend = createTelegramFrontend(config);
  log("bot", "Frontend: Telegram");
}

// ── Create backend (dynamic import) ──────────────────────────────────────────

let backend: QueryBackend;
if (config.backend === "opencode") {
  const { initOpenCodeAgent, handleMessage: opencodeHandleMessage } = await import("./backend/opencode/index.js");
  initOpenCodeAgent(config, frontend.getBridgePort);
  backend = { query: (params) => opencodeHandleMessage(params) };
  log("bot", "Backend: OpenCode");
} else {
  const { initAgent: initClaudeAgent, handleMessage: claudeHandleMessage } = await import("./backend/claude-sdk/index.js");
  initClaudeAgent(config, frontend.getBridgePort);
  backend = { query: (params) => claudeHandleMessage(params) };
  log("bot", "Backend: Claude SDK");
}

// ── Wire dispatcher ─────────────────────────────────────────────────────────

initDispatcher({
  backend,
  context: frontend.context,
  sendTyping: frontend.sendTyping,
  onActivity: () => resetPulseTimer(),
  concurrency: config.concurrency,
});

// ── Initialize schedulers ───────────────────────────────────────────────────

initPulse();
initCron({ sendMessage: frontend.sendMessage });

// ── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", `${signal} received, shutting down gracefully...`);

  const forceTimer = setTimeout(() => {
    logError("shutdown", "Timeout exceeded, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  const pending = getQueueSize();
  if (pending > 0) {
    log("shutdown", `Waiting for ${pending} in-flight queries to drain...`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  await frontend.stop();
  if (config.backend === "opencode") {
    const { stopOpenCodeServer } = await import("./backend/opencode/index.js");
    stopOpenCodeServer();
  }
  // Destroy plugins (cleanup resources)
  if (config.plugins.length > 0) {
    const { destroyPlugins } = await import("./core/plugin.js");
    await destroyPlugins();
  }
  stopPulseTimer();
  stopCronTimer();
  stopWatchdog();
  stopUploadCleanup();
  flushSessions();
  flushChatSettings();
  flushCronJobs();
  flushHistory();
  flushMediaIndex();
  log("shutdown", "State saved");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logError("bot", "Uncaught exception", err);
  flushSessions();
  flushChatSettings();
  flushCronJobs();
  flushHistory();
  flushMediaIndex();
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
  await frontend.init();
  log("bot", "Starting Talon...");

  if (config.pulse) startPulseTimer(config.pulseIntervalMs);
  startCronTimer();
  startWatchdog(config.workspace);
  startUploadCleanup(config.workspace);

  await frontend.start();
}

main().catch((err) => {
  logError("bot", "Fatal startup error", err);
  process.exit(1);
});
