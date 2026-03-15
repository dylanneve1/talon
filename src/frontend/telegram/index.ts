/**
 * Telegram frontend factory.
 *
 * Encapsulates everything Telegram-specific: Bot instance, bridge server,
 * command registration, GramJS userbot, graceful shutdown.
 *
 * index.ts calls createTelegramFrontend() and gets back a Frontend interface —
 * no grammy imports leak into the composition root.
 */

import { Bot, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { TalonConfig } from "../../util/config.js";
import type { ContextManager } from "../../core/types.js";
import {
  startBridge,
  stopBridge,
  setBridgeBotToken,
  setBridgeContext,
  clearBridgeContext,
  isBridgeBusy,
  getBridgeMessageCount,
  getBridgePort,
  sendText,
} from "./bridge/server.js";
import {
  initUserClient,
  disconnectUserClient,
} from "./userbot.js";
import { registerCommands } from "./commands.js";
import { registerMiddleware } from "./middleware.js";
import { registerCallbacks } from "./callbacks.js";
import { log, logError } from "../../util/log.js";

// ── Frontend interface ──────────────────────────────────────────────────────

export type TelegramFrontend = {
  /** ContextManager for the dispatcher — manages bridge context lifecycle. */
  context: ContextManager;
  /** Show typing indicator in a chat. */
  sendTyping: (chatId: number) => Promise<void>;
  /** Send a plain text message to a chat. */
  sendMessage: (chatId: number, text: string) => Promise<void>;
  /** Get the bridge port (needed by backend for MCP tool config). */
  getBridgePort: () => number;
  /** Initialize: start bridge, register handlers, set up userbot. */
  init: () => Promise<void>;
  /** Start polling for Telegram updates. */
  start: () => Promise<void>;
  /** Gracefully stop bot, bridge, and userbot. */
  stop: () => Promise<void>;
};

// ── Factory ─────────────────────────────────────────────────────────────────

export function createTelegramFrontend(config: TalonConfig): TelegramFrontend {
  const bot = new Bot(config.botToken);
  // Auto-retry on Telegram 429 (flood wait) — respects retry_after header
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  setBridgeBotToken(config.botToken);

  const context: ContextManager = {
    acquire: (chatId: number) => setBridgeContext(chatId, bot, InputFile),
    release: (chatId: number) => clearBridgeContext(chatId),
    isBusy: () => isBridgeBusy(),
    getMessageCount: () => getBridgeMessageCount(),
  };

  return {
    context,

    sendTyping: (chatId: number) =>
      bot.api.sendChatAction(chatId, "typing").then(() => {}),

    sendMessage: async (chatId: number, text: string) => {
      await sendText(bot, chatId, text);
    },

    getBridgePort: () => getBridgePort(),

    async init() {
      const port = await startBridge(19876);
      log("bot", `Bridge started on port ${port}`);

      // Register bot handlers
      registerCommands(bot, config);
      registerMiddleware(bot, config);
      registerCallbacks(bot, config);

      // Register slash commands with Telegram
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
    },

    async start() {
      bot.catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logError("bot", "Unhandled bot error", err);
        // If token is revoked/invalid, there's no point continuing
        if (/unauthorized|401|not found|404/i.test(msg)) {
          logError("bot", "Bot token appears invalid — shutting down");
          process.exit(1);
        }
      });
      await bot.start({
        onStart: (info) => log("bot", `Talon running as @${info.username}`),
      });
    },

    async stop() {
      try { await bot.stop(); log("shutdown", "Bot disconnected"); }
      catch (err) { logError("shutdown", "Bot stop error", err); }
      try { await disconnectUserClient(); log("shutdown", "User client disconnected"); }
      catch (err) { logError("shutdown", "User client disconnect error", err); }
      try { await stopBridge(); log("shutdown", "Bridge stopped"); }
      catch (err) { logError("shutdown", "Bridge stop error", err); }
    },
  };
}
