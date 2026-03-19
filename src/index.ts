/**
 * Talon — agentic AI harness.
 * Composition root: loads config, creates frontend + backend, wires dispatcher.
 *
 * Frontends (Telegram, Teams, Terminal) and backends (Claude, OpenCode)
 * are loaded dynamically — only the selected platform's dependencies are required.
 */

import { loadConfig } from "./util/config.js";
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
import { getFrontends } from "./util/config.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();

// Expose search config as env vars for gateway-actions
if (config.braveApiKey) process.env.TALON_BRAVE_API_KEY = config.braveApiKey;
if (config.searxngUrl) process.env.TALON_SEARXNG_URL = config.searxngUrl;

initWorkspace(config.workspace);
loadSessions();
loadChatSettings();
loadCronJobs();
loadHistory();
loadMediaIndex();
cleanupOldLogs();

// ── Create frontends (dynamic import — only selected platforms' deps required) ─

type Frontend = {
  context: ContextManager;
  sendTyping: (chatId: string) => Promise<void>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

const enabledFrontends = getFrontends(config);
const frontends: Frontend[] = [];

for (const fe of enabledFrontends) {
  switch (fe) {
    case "teams": {
      const { createTeamsFrontend } = await import("./frontend/teams/index.js");
      frontends.push(createTeamsFrontend(config));
      break;
    }
    case "terminal": {
      const { createTerminalFrontend } = await import("./frontend/terminal/index.js");
      frontends.push(createTerminalFrontend(config));
      break;
    }
    default: {
      const { createTelegramFrontend } = await import("./frontend/telegram/index.js");
      frontends.push(createTelegramFrontend(config));
      break;
    }
  }
}

if (frontends.length === 0) throw new Error("No frontends configured");

// Multiplexed frontend — routes by chatId prefix to the correct frontend
const prefixMap: Array<{ prefix: string; frontend: Frontend }> = enabledFrontends.map((fe, i) => ({
  prefix: fe === "telegram" ? "tg:" : fe === "teams" ? "teams:" : "terminal",
  frontend: frontends[i],
}));

function routeByPrefix(chatId: string): Frontend | undefined {
  for (const { prefix, frontend: f } of prefixMap) {
    if (chatId.startsWith(prefix)) return f;
  }
  return frontends[0]; // fallback
}

const frontend: Frontend = frontends.length === 1 ? frontends[0] : {
  context: {
    acquire: (chatId: string) => { const f = routeByPrefix(chatId); if (f) f.context.acquire(chatId); },
    release: (chatId: string) => { const f = routeByPrefix(chatId); if (f) f.context.release(chatId); },
    isBusy: () => frontends.some((f) => f.context.isBusy()),
    getMessageCount: () => {
      // All frontends share the same gateway singleton, so just query once
      return frontends[0].context.getMessageCount();
    },
  },
  sendTyping: async (chatId: string) => {
    const f = routeByPrefix(chatId);
    if (f) await f.sendTyping(chatId);
  },
  sendMessage: async (chatId: string, text: string) => {
    const f = routeByPrefix(chatId);
    if (f) await f.sendMessage(chatId, text);
  },
  getBridgePort: () => frontends[0].getBridgePort(),
  init: async () => { for (const f of frontends) await f.init(); },
  start: async () => {
    // Start all frontends concurrently (Telegram polls, Teams listens)
    await Promise.all(frontends.map((f) => f.start()));
  },
  stop: async () => { for (const f of frontends) await f.stop(); },
};

// ── Create backend (dynamic import — only selected backend's deps required) ──

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

  // Force exit if shutdown takes too long
  const forceTimer = setTimeout(() => {
    logError("shutdown", "Timeout exceeded, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref(); // don't keep process alive

  // Wait for in-flight queries to drain
  const pending = getQueueSize();
  if (pending > 0) {
    log("shutdown", `Waiting for ${pending} in-flight queries to drain...`);
    // Give queries a few seconds to finish, then proceed
    await new Promise((r) => setTimeout(r, 5000));
  }

  await frontend.stop();
  if (config.backend === "opencode") {
    const { stopOpenCodeServer } = await import("./backend/opencode/index.js");
    stopOpenCodeServer();
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
  // Teams conversation store flush — module was already imported during init,
  // so we can access it via the cached frontend's stop (which calls flush synchronously)
  for (const f of frontends) {
    try { f.stop(); } catch { /* best effort */ }
  }
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
