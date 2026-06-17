/**
 * Discord frontend factory.
 *
 * Creates a discord.js Client, wires up:
 *  - access control (config.discord.allowedUsers / allowedGuilds / allowedChannels / adminUserIds)
 *  - slash command registration (per-guild for allowedGuilds, optional global for DM)
 *  - message handlers (mention/reply/channel-mode gating)
 *  - component (button/select) interaction routing → callbacks.ts
 *  - guildCreate auto-leave for non-whitelisted guilds (+ admin notify)
 *  - graceful shutdown
 *
 * Registers a Discord-specific action handler with the gateway so MCP tool
 * calls (send_message, react, etc.) reach the Discord API.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  Events,
} from "discord.js";
import { once } from "node:events";
import type { TalonConfig } from "../../util/config.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { log, logError, logWarn } from "../../util/log.js";
import { createDiscordActionHandler } from "./actions/index.js";
import {
  registerCommandsForGuilds,
  registerInteractionRouter,
} from "./commands/index.js";
import { registerMiddleware } from "./middleware.js";
import {
  setAccessControl,
  lookupDiscordChat,
  registerDiscordChat,
} from "./handlers/index.js";
import { sendChunked } from "./handlers/index.js";
import { deriveNumericChatId } from "../../util/chat-id.js";

// ── Frontend type ───────────────────────────────────────────────────────────

export type DiscordFrontend = {
  name: "discord";
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

// ── Factory ─────────────────────────────────────────────────────────────────

export function createDiscordFrontend(
  config: TalonConfig,
  gateway: Gateway,
): DiscordFrontend {
  if (!config.discord) {
    throw new Error(
      "Discord config missing — add a 'discord' block to talon.json.",
    );
  }
  const dc = config.discord;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
    allowedMentions: { parse: [] }, // never ping anyone unless we explicitly opt in
  });

  // Wire access control config into handlers.ts
  setAccessControl({
    allowedUsers: dc.allowedUsers,
    allowedGuilds: dc.allowedGuilds,
    allowedChannels: dc.allowedChannels,
    adminUserIds: dc.adminUserIds,
    respondMode: dc.respondMode,
  });

  const context: ContextManager = {
    acquire: (chatId: number, stringId?: string) =>
      gateway.setContext(chatId, stringId),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  // sendTyping: looks up the registered Discord channel and sends typing.
  // No-ops gracefully if we don't have the channel cached yet.
  const sendTyping = async (chatId: number): Promise<void> => {
    const info = lookupDiscordChat(chatId);
    if (!info) return;
    try {
      const ch = await client.channels.fetch(info.channelId);
      if (ch && "sendTyping" in ch) {
        await (ch as { sendTyping: () => Promise<void> }).sendTyping();
      }
    } catch {
      /* channel not resolvable — ignore */
    }
  };

  // sendMessage (plain): used by cron and pulse to reach a specific chat.
  // chatId here is the numericChatId stored in the registry.
  const sendMessage = async (chatId: number, text: string): Promise<void> => {
    if (!text.trim()) return;
    const info = lookupDiscordChat(chatId);
    if (!info) {
      logWarn(
        "discord",
        `sendMessage: no registered channel for chatId ${chatId}`,
      );
      return;
    }
    try {
      const ch = await client.channels.fetch(info.channelId);
      if (
        ch &&
        "isSendable" in ch &&
        (ch as { isSendable: () => boolean }).isSendable()
      ) {
        await sendChunked(ch as never, text);
      }
    } catch (err) {
      logError(
        "discord",
        `sendMessage failed for chat ${chatId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  return {
    name: "discord",
    context,
    sendTyping,
    sendMessage,
    getBridgePort: () => gateway.getPort(),

    async init() {
      // Register Discord action handler with the gateway
      gateway.setFrontendHandler(createDiscordActionHandler(client, gateway));

      const port = await gateway.start(19876);
      log("discord", `Gateway started on port ${port}`);

      // Hook event listeners BEFORE login so we don't miss the ready event.
      client.once("clientReady", async (c) => {
        log("discord", `Logged in as ${c.user.tag} (${c.user.id})`);

        if (dc.presence) {
          try {
            c.user.setPresence({
              activities: [{ name: dc.presence, type: ActivityType.Custom }],
              status: "online",
            });
          } catch {
            /* ignore */
          }
        }

        // Discover any existing DM channels with allowedUsers and register them
        // in the chat registry so cron/pulse can target them. We don't pre-open
        // unrequested DMs — only those Discord already exposes.
        for (const userId of dc.allowedUsers) {
          try {
            const user = await c.users.fetch(userId);
            const dm = await user.createDM();
            const chatId = `discord_dm_${userId}`;
            registerDiscordChat({
              channelId: dm.id,
              guildId: null,
              userId,
              numericChatId: deriveNumericChatId(chatId),
              chatId,
            });
          } catch {
            /* user not reachable — skip */
          }
        }

        // Register slash commands per-guild + optionally global for DM
        try {
          await registerCommandsForGuilds(c, config);
        } catch (err) {
          logError("discord", "Slash command registration failed", err);
        }

        // Defense in depth: leave any guild we're in but isn't whitelisted
        if (dc.leaveUnauthorizedGuilds) {
          for (const guild of c.guilds.cache.values()) {
            if (dc.allowedGuilds.includes(guild.id)) continue;
            log(
              "discord",
              `Leaving non-whitelisted guild "${guild.name}" (${guild.id})`,
            );
            // Notify admins
            for (const adminId of dc.adminUserIds) {
              try {
                const admin = await c.users.fetch(adminId);
                await admin.send({
                  content: `🚪 Leaving non-whitelisted guild "${guild.name}" (${guild.id}).`,
                  allowedMentions: { parse: [] },
                });
              } catch {
                /* ignore */
              }
            }
            try {
              await guild.leave();
            } catch (err) {
              logWarn(
                "discord",
                `Failed to leave guild ${guild.id}: ${err instanceof Error ? err.message : err}`,
              );
            }
          }
        }
      });

      // guildCreate: bot was added to a new guild → enforce whitelist immediately
      client.on("guildCreate", async (guild) => {
        if (dc.allowedGuilds.includes(guild.id)) {
          log(
            "discord",
            `Joined whitelisted guild "${guild.name}" (${guild.id})`,
          );
          // Re-register commands for this guild
          try {
            await registerCommandsForGuilds(client, config);
          } catch (err) {
            logError(
              "discord",
              `Re-register commands after guildCreate failed`,
              err,
            );
          }
          return;
        }
        log(
          "discord",
          `Joined non-whitelisted guild "${guild.name}" (${guild.id})`,
        );
        // Notify admins
        for (const adminId of dc.adminUserIds) {
          try {
            const admin = await client.users.fetch(adminId);
            await admin.send({
              content: dc.leaveUnauthorizedGuilds
                ? `🚨 Bot was added to non-whitelisted guild "${guild.name}" (${guild.id}). Leaving.`
                : `⚠️ Bot was added to non-whitelisted guild "${guild.name}" (${guild.id}). Commands will not be registered.`,
              allowedMentions: { parse: [] },
            });
          } catch {
            /* ignore */
          }
        }
        if (dc.leaveUnauthorizedGuilds) {
          try {
            await guild.leave();
          } catch (err) {
            logWarn(
              "discord",
              `Failed to leave guild ${guild.id}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      });

      client.on("error", (err) => {
        logError("discord", "Client error", err);
      });
      client.on("warn", (msg) => {
        logWarn("discord", msg);
      });

      // Surface gateway close codes — discord.js auto-reconnects on most, but
      // 4004 (auth failed), 4013 (invalid intents), 4014 (disallowed intents)
      // are terminal: the bot will hang silent in IDENTIFY without an alert.
      client.on(Events.ShardDisconnect, (event, shardId) => {
        const code = event?.code;
        const reason = event?.reason || "(no reason)";
        const fatal = code === 4004 || code === 4013 || code === 4014;
        const label =
          code === 4004
            ? "AUTHENTICATION_FAILED — bot token invalid/revoked"
            : code === 4013
              ? "INVALID_INTENTS — declared intent doesn't exist"
              : code === 4014
                ? "DISALLOWED_INTENTS — privileged intent (GuildMembers/MessageContent/Presence) not enabled in Developer Portal"
                : `code=${code}`;
        if (fatal) {
          logError(
            "discord",
            `Shard ${shardId} disconnected fatally: ${label} (${reason})`,
          );
        } else {
          logWarn(
            "discord",
            `Shard ${shardId} disconnected: ${label} (${reason})`,
          );
        }
      });

      // Rate-limit / invalid-request observability. discord.js handles retries
      // automatically; we just want logs so we know when we're flirting with
      // the Cloudflare 10k-invalid-requests/10min cap.
      client.rest.on("rateLimited", (info) => {
        logWarn(
          "discord",
          `Rate-limited ${info.method} ${info.route} — wait ${info.timeToReset}ms (global=${info.global})`,
        );
      });
      client.rest.on("invalidRequestWarning", (info) => {
        logError(
          "discord",
          `Invalid-request warning: ${info.count} bad requests in last ${info.remainingTime}ms — approaching IP ban threshold`,
        );
      });

      // Wire message handlers and slash command/component routers
      registerMiddleware(client, config);
      registerInteractionRouter(client, config, gateway);
    },

    async start() {
      await client.login(dc.botToken);
      // Wait for the WebSocket READY event before returning — login() resolves
      // after HTTP IDENTIFY but client.user / client.guilds.cache are empty
      // until READY fires. Anything called after start() can then safely read
      // gateway state.
      if (!client.isReady()) {
        await once(client, Events.ClientReady);
      }
    },

    async stop() {
      try {
        await client.destroy();
        log("shutdown", "Discord client disconnected");
      } catch (err) {
        logError("shutdown", "Discord stop error", err);
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
