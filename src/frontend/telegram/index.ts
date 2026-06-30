/**
 * Telegram frontend factory.
 *
 * Encapsulates everything Telegram-specific: Bot instance, command registration,
 * GramJS userbot, graceful shutdown. Registers its action handler with the
 * core gateway so MCP tool calls route to Telegram API.
 */

import { Bot, InputFile, API_CONSTANTS } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { TalonConfig } from "../../util/config.js";
import { soulEnabled } from "../../core/soul/settings.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { createTelegramActionHandler, sendText } from "./actions/index.js";
import { initUserClient, disconnectUserClient } from "./userbot.js";
import {
  registerCommands,
  setAdminUserId,
  TELEGRAM_COMMANDS,
} from "./commands/index.js";
import { setAccessControl } from "./handlers/index.js";
import { registerMiddleware } from "./middleware.js";
import { registerCallbacks } from "./callbacks/index.js";
import { log, logError } from "../../util/log.js";

// ── Frontend interface ──────────────────────────────────────────────────────

export type TelegramFrontend = {
  name: "telegram";
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

// ── Factory ─────────────────────────────────────────────────────────────────

export function createTelegramFrontend(
  config: TalonConfig,
  gateway: Gateway,
): TelegramFrontend {
  const bot = new Bot(config.botToken!);
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

  const context: ContextManager = {
    acquire: (chatId: number, stringId?: string) =>
      gateway.setContext(chatId, stringId, "telegram"),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  return {
    name: "telegram",
    context,

    sendTyping: (chatId: number) =>
      bot.api.sendChatAction(chatId, "typing").then(() => {}),

    sendMessage: async (chatId: number, text: string) => {
      await sendText(bot, chatId, text);
    },

    getBridgePort: () => gateway.getPort(),

    async init() {
      // Register Telegram action handler with the core gateway
      gateway.registerFrontendHandler(
        "telegram",
        createTelegramActionHandler(bot, InputFile, config.botToken!, gateway),
      );

      const port = await gateway.start(19876);
      log("bot", `Gateway started on port ${port}`);

      setAdminUserId(config.adminUserId);
      setAccessControl({
        allowedUsers: config.allowedUsers,
        adminUserId: config.adminUserId,
      });

      registerCommands(bot, config, gateway);
      registerMiddleware(bot, config);
      registerCallbacks(bot, config, gateway);

      await bot.api.deleteMyCommands();
      await bot.api.setMyCommands([...TELEGRAM_COMMANDS]);
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
        if (/unauthorized|401|not found|404/i.test(msg)) {
          logError("bot", "Bot token appears invalid — shutting down");
          process.exit(1);
        }
      });
      // Reactions arrive only if we explicitly request `message_reaction`
      // (it is absent from grammY's default allowed_updates). Subscribe only
      // when the soul is enabled, so a soulless deployment keeps the default
      // update set and behaves byte-identically.
      const allowedUpdates = soulEnabled(config.soul)
        ? [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, "message_reaction" as const]
        : undefined;
      await bot.start({
        allowed_updates: allowedUpdates,
        onStart: (info) => log("bot", `Talon running as @${info.username}`),
      });
    },

    async stop() {
      try {
        await bot.stop();
        log("shutdown", "Bot disconnected");
      } catch (err) {
        logError("shutdown", "Bot stop error", err);
      }
      try {
        await disconnectUserClient();
        log("shutdown", "User client disconnected");
      } catch (err) {
        logError("shutdown", "User client disconnect error", err);
      }
      try {
        await gateway.stop();
        log("shutdown", "Gateway stopped");
      } catch (err) {
        logError("shutdown", "Gateway stop error", err);
      }
    },
  };
}
