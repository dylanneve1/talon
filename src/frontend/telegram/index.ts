/**
 * Telegram frontend entry point.
 *
 * Selects between two implementations at runtime:
 *  - Bot mode   (default): Grammy bot API — requires botToken
 *  - Userbot mode        : GramJS user account — requires apiId + apiHash, no botToken
 *
 * Mode is auto-detected from config:
 *  - botToken absent AND apiId + apiHash present → userbot mode
 *  - otherwise → bot mode (existing behaviour, unchanged)
 *
 * Both modes implement the same TelegramFrontend interface so the rest of the
 * system (dispatcher, gateway, pulse, cron …) is completely unaware of which
 * mode is active.
 */

import { Bot, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import type { TalonConfig } from "../../util/config.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/gateway.js";
import { createTelegramActionHandler, sendText } from "./actions.js";
import {
  initUserClient,
  disconnectUserClient,
  fetchSelfInfo,
  getSelfInfo,
  isUserClientReady,
} from "./userbot.js";
import { registerCommands, setAdminUserId } from "./commands.js";
import { registerMiddleware } from "./middleware.js";
import { registerCallbacks } from "./callbacks.js";
import { createUserbotFrontend } from "./userbot-frontend.js";
import { createUserbotActionHandler } from "./userbot-actions.js";
import { log, logError, logWarn } from "../../util/log.js";

// ── Shared interface ────────────────────────────────────────────────────────

export type TelegramFrontend = {
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

// ── Mode detection ───────────────────────────────────────────────────────────

/**
 * Returns true when the config signals userbot (user-account) primary mode:
 * no bot token, but MTProto credentials are present.
 */
export function isUserbotMode(config: TalonConfig): boolean {
  // userbot-only: no bot token, but MTProto credentials present
  return !config.botToken && !!config.apiId && !!config.apiHash;
}

/** Returns true when both a bot token AND MTProto credentials are configured → run both simultaneously. */
export function isDualMode(config: TalonConfig): boolean {
  return !!config.botToken && !!config.apiId && !!config.apiHash;
}

// ── Top-level factory (picks the right implementation) ───────────────────────

export function createTelegramFrontend(config: TalonConfig, gateway: Gateway): TelegramFrontend {
  if (isDualMode(config)) {
    log("bot", "Bot token + userbot credentials detected — starting in dual mode (bot + userbot simultaneously).");
    return createDualFrontend(config, gateway);
  }
  if (isUserbotMode(config)) {
    log("bot", "No botToken detected — starting in userbot (user account) primary mode.");
    return createUserbotFrontend(config, gateway);
  }
  return createBotFrontend(config, gateway);
}

// ── Bot-mode frontend (Grammy — existing behaviour) ──────────────────────────

function createBotFrontend(config: TalonConfig, gateway: Gateway): TelegramFrontend {
  const bot = new Bot(config.botToken!);
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

  const context: ContextManager = {
    acquire: (chatId: number) => gateway.setContext(chatId),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  return {
    context,

    sendTyping: (chatId: number) =>
      bot.api.sendChatAction(chatId, "typing").then(() => {}),

    sendMessage: async (chatId: number, text: string) => {
      await sendText(bot, chatId, text);
    },

    getBridgePort: () => gateway.getPort(),

    async init() {
      // Register Telegram action handler with the core gateway
      gateway.setFrontendHandler(createTelegramActionHandler(bot, InputFile, config.botToken!, gateway));

      const port = await gateway.start(19876);
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
        { command: "restart", description: "Restart the bot (admin)" },
        { command: "dream", description: "Force memory consolidation" },
        { command: "plugins", description: "List loaded plugins" },
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
      try { await gateway.stop(); log("shutdown", "Gateway stopped"); }
      catch (err) { logError("shutdown", "Gateway stop error", err); }
    },
  };
}

// ── Dual-mode frontend (Grammy bot + GramJS user account simultaneously) ─────

/**
 * Runs both the Grammy bot frontend AND the GramJS user-account frontend
 * at the same time. Each handles the chats it naturally owns:
 * - Bot receives messages via Telegram Bot API polling
 * - Userbot receives messages via MTProto (GramJS) events
 *
 * Action routing: a per-chat ownership map decides which API to use when
 * Claude sends a tool call (e.g. send_message). The frontend that received
 * the incoming message sets ownership; the composite gateway handler uses it.
 */
function createDualFrontend(config: TalonConfig, gateway: Gateway): TelegramFrontend {
  // Track which frontend received the last message for each chat.
  // Default: 'bot' — safe fallback since bot is more reliable for sending.
  const chatOwnership = new Map<number, "bot" | "userbot">();

  // ── Message deduplication ─────────────────────────────────────────────────
  // In dual mode, both frontends see group messages. Without dedup, both
  // would process and respond to the same message → duplicate replies.
  // First frontend to claim a message wins; the other skips it.
  const claimedMessages = new Map<string, "bot" | "userbot">();
  const CLAIM_CAP = 5_000;

  /**
   * Try to claim a message for processing. Returns true if this frontend
   * should process it, false if the other frontend already claimed it.
   */
  function claimMessage(chatId: number, msgId: number, frontend: "bot" | "userbot"): boolean {
    const key = `${chatId}:${msgId}`;
    const existing = claimedMessages.get(key);
    if (existing) return existing === frontend; // already claimed
    claimedMessages.set(key, frontend);
    chatOwnership.set(chatId, frontend);
    // LRU eviction
    if (claimedMessages.size > CLAIM_CAP) {
      const iter = claimedMessages.keys();
      for (let i = 0; i < 1000; i++) claimedMessages.delete(iter.next().value as string);
    }
    return true;
  }

  // Export claim function for both frontends
  const claimForBot = (chatId: number, msgId: number) => claimMessage(chatId, msgId, "bot");
  const claimForUserbot = (chatId: number, msgId: number) => claimMessage(chatId, msgId, "userbot");

  const markBotOwned = (chatId: number) => chatOwnership.set(chatId, "bot");
  const markUserbotOwned = (chatId: number) => chatOwnership.set(chatId, "userbot");

  // ── Bot setup (Grammy) ────────────────────────────────────────────────────
  const bot = new Bot(config.botToken!);
  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

  // ── Userbot sub-frontend (non-primary: scope guard stays active) ──────────
  // Pass onChatOwned to record ownership when userbot handles a message.
  const userbotFrontend = createUserbotFrontend(config, gateway, {
    primaryMode: false,
    onChatOwned: markUserbotOwned,
    claimMessage: claimForUserbot,
  });

  // ── Shared context manager ────────────────────────────────────────────────
  const context: ContextManager = {
    acquire: (chatId: number) => gateway.setContext(chatId),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  return {
    context,

    sendTyping: async (chatId: number) => {
      if (chatOwnership.get(chatId) === "userbot") {
        return userbotFrontend.sendTyping(chatId);
      }
      return bot.api.sendChatAction(chatId, "typing").then(() => {});
    },

    sendMessage: async (chatId: number, text: string) => {
      if (chatOwnership.get(chatId) === "userbot") {
        return userbotFrontend.sendMessage(chatId, text);
      }
      await sendText(bot, chatId, text);
    },

    getBridgePort: () => gateway.getPort(),

    async init() {
      // ── Bot action handler (Grammy) ───────────────────────────────────────
      const botHandler = createTelegramActionHandler(bot, InputFile, config.botToken!, gateway);

      // Step 1: Start the gateway (idempotent — safe to call twice)
      const port = await gateway.start(19876);
      log("bot", `Dual-mode gateway on port ${port}`);

      // Step 2: Bot-side setup (commands, middleware, callbacks)
      setAdminUserId(config.adminUserId);
      registerCommands(bot, config);
      registerMiddleware(bot, config, markBotOwned, claimForBot);
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
        { command: "restart", description: "Restart the bot (admin)" },
        { command: "dream", description: "Force memory consolidation" },
        { command: "plugins", description: "List loaded plugins" },
        { command: "help", description: "All commands and features" },
      ]);
      log("commands", "Registered bot commands with Telegram (dual mode)");

      // Step 3: Initialize the GramJS user client (without gateway setup)
      const ok = await initUserClient({
        apiId: config.apiId!,
        apiHash: config.apiHash!,
      });
      if (!ok) {
        logWarn("bot", "Dual mode: user client not authorized — userbot features disabled. Run: npx tsx src/login.ts");
      } else {
        await fetchSelfInfo();
        const self = getSelfInfo();
        if (self) {
          log("bot", `Dual mode: userbot running as ${self.firstName ?? ""} @${self.username ?? ""} (id:${self.id})`);
        }
      }

      // Step 4: Build composite gateway handler that routes by chat ownership
      const userbotHandler = createUserbotActionHandler(gateway, (chatId, msgId) => {
        markUserbotOwned(Number(chatId));
        void msgId;
      });

      gateway.setFrontendHandler(async (body, chatId) => {
        const owner = chatOwnership.get(chatId) ?? "bot";
        if (owner === "userbot") {
          // Userbot-owned chat: userbot handles everything
          return await userbotHandler(body, chatId);
        }
        // Bot-owned chat: try bot handler first, fall back to userbot for
        // advanced tools (profile, cross-chat, privacy, etc.) that only
        // work via the MTProto user session.
        const result = await botHandler(body, chatId);
        if (result !== null) return result;
        return await userbotHandler(body, chatId);
      });
    },

    async start() {
      // Start the GramJS event listener if user client is ready
      if (isUserClientReady()) {
        await userbotFrontend.start().catch((err) => {
          logError("bot", "Dual mode: userbot start failed — bot-only mode active", err);
        });
      }

      // Start Grammy bot polling (this is the blocking call for this frontend)
      bot.catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logError("bot", "Dual mode: unhandled bot error", err);
        if (/unauthorized|401|not found|404/i.test(msg)) {
          logError("bot", "Bot token invalid — shutting down");
          process.exit(1);
        }
      });
      await bot.start({
        onStart: (info) => log("bot", `Dual mode: bot running as @${info.username}`),
      });
    },

    async stop() {
      try { await bot.stop(); log("shutdown", "Dual mode: bot disconnected"); }
      catch (err) { logError("shutdown", "Bot stop error", err); }
      try { await disconnectUserClient(); log("shutdown", "Dual mode: user client disconnected"); }
      catch (err) { logError("shutdown", "User client disconnect error", err); }
      try { await gateway.stop(); log("shutdown", "Gateway stopped"); }
      catch (err) { logError("shutdown", "Gateway stop error", err); }
    },
  };
}
