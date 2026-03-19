/**
 * Telegram frontend factory.
 *
 * Encapsulates everything Telegram-specific: Bot instance, command registration,
 * GramJS userbot, graceful shutdown. Registers its action handler with the
 * core gateway so MCP tool calls route to Telegram API.
 */

import { Bot, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { TalonConfig } from "../../util/config.js";
import type { ContextManager } from "../../core/types.js";
import {
  startGateway,
  stopGateway,
  setGatewayContext,
  clearGatewayContext,
  isGatewayBusy,
  getGatewayMessageCount,
  getGatewayPort,
  setFrontendHandler,
} from "../../core/gateway.js";
import { createTelegramActionHandler, sendText } from "./actions.js";
import {
  initUserClient,
  disconnectUserClient,
} from "./userbot.js";
import { registerCommands, setAdminUserId } from "./commands.js";
import { registerMiddleware } from "./middleware.js";
import { registerCallbacks } from "./callbacks.js";
import { log, logError } from "../../util/log.js";

// ── Frontend interface ──────────────────────────────────────────────────────

export type TelegramFrontend = {
  context: ContextManager;
  sendTyping: (chatId: string) => Promise<void>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

// ── Factory ─────────────────────────────────────────────────────────────────

export function createTelegramFrontend(config: TalonConfig): TelegramFrontend {
  if (!config.botToken) throw new Error("Missing botToken for Telegram frontend");
  const bot = new Bot(config.botToken);
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

  const context: ContextManager = {
    acquire: (chatId: string) => setGatewayContext(chatId),
    release: (chatId: string) => clearGatewayContext(chatId),
    isBusy: () => isGatewayBusy(),
    getMessageCount: () => getGatewayMessageCount(),
  };

  return {
    context,

    sendTyping: (chatId: string) =>
      bot.api.sendChatAction(Number(chatId.replace(/^tg:/, "")), "typing").then(() => {}),

    sendMessage: async (chatId: string, text: string) => {
      await sendText(bot, Number(chatId.replace(/^tg:/, "")), text);
    },

    getBridgePort: () => getGatewayPort(),

    async init() {
      // Register Telegram action handler with the core gateway
      setFrontendHandler(createTelegramActionHandler(bot, InputFile, config.botToken!));

      const port = await startGateway(19876);
      log("bot", `Gateway started on port ${port}`);

      setAdminUserId(config.adminUserId);

      registerCommands(bot, config);
      registerMiddleware(bot, config);
      registerCallbacks(bot, config);

      await bot.api.deleteMyCommands();
      await bot.api.setMyCommands([
        { command: "start", description: "Introduction" },
        { command: "settings", description: "View and change all chat settings" },
        { command: "memory", description: "View what Talon remembers" },
        { command: "status", description: "Session info, usage, and stats" },
        { command: "ping", description: "Health check with latency" },
        { command: "model", description: "Show or change model" },
        { command: "effort", description: "Set thinking effort level" },
        { command: "pulse", description: "Conversation engagement settings" },
        { command: "reset", description: "Clear session and start fresh" },
        { command: "help", description: "All commands and features" },
      ]);
      log("commands", "Registered bot commands with Telegram");

      const apiId = config.apiId ?? 0;
      const apiHash = config.apiHash ?? "";
      if (apiId && apiHash) {
        initUserClient({ apiId, apiHash })
          .then((ok) => {
            if (ok) log("userbot", "Full Telegram history access enabled.");
            else log("userbot", "Not authorized. Run: npx tsx src/login.ts");
          })
          .catch((err) => logError("userbot", "Init failed", err));
      } else {
        log("userbot", "TALON_API_ID/TALON_API_HASH not set -- using in-memory history only.");
      }
    },

    async start() {
      bot.catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logError("bot", "Unhandled bot error", err);
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
      try { await stopGateway(); log("shutdown", "Gateway stopped"); }
      catch (err) { logError("shutdown", "Gateway stop error", err); }
    },
  };
}
