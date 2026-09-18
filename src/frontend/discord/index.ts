/**
 * Discord frontend factory.
 *
 * Creates a discord.js Client, wires up:
 *  - access control (config.discord.allowedUsers / allowedGuilds / allowedChannels / adminUserIds)
 *  - slash command registration (per-guild for allowedGuilds, optional global for DM)
 *  - message handlers (mention/reply/channel-mode gating)
 *  - component (button/select) interaction routing → callbacks/
 *  - guildCreate auto-leave for non-whitelisted guilds (+ admin notify)
 *  - graceful shutdown
 *
 * Registers a Discord-specific action handler with the gateway so MCP tool
 * calls (send_message, react, etc.) reach the Discord API.
 *
 * This file is wiring only: it constructs the shared runtime (runtime.ts),
 * binds the client's event handlers, and owns the frontend surface. The
 * behaviour lives in the modules — ready, guild-policy, diagnostics,
 * outbound, connection, and the handlers/commands/callbacks trees.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { log } from "../../util/log.js";
import { createDiscordActionHandler } from "./actions/index.js";
import { registerInteractionRouter } from "./commands/index.js";
import { connect, disconnect } from "./connection.js";
import { bindClientDiagnostics } from "./diagnostics.js";
import { onGuildCreate } from "./guild-policy.js";
import { setAccessControl } from "./handlers/index.js";
import { registerMiddleware } from "./middleware.js";
import { sendMessage, sendTyping } from "./outbound.js";
import { onClientReady } from "./ready.js";
import { createDiscordRuntime, type DiscordRuntime } from "./runtime.js";

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

async function init(runtime: DiscordRuntime): Promise<void> {
  const { client, config, gateway } = runtime;

  // Register Discord action handler with the gateway
  gateway.registerFrontendHandler(
    "discord",
    createDiscordActionHandler(client, gateway),
  );

  const port = await gateway.start(19876);
  log("discord", `Gateway started on port ${port}`);

  // Hook event listeners BEFORE login so we don't miss the ready event.
  client.once("clientReady", (c) => onClientReady(runtime, c));
  client.on("guildCreate", (guild) => onGuildCreate(runtime, guild));
  bindClientDiagnostics(client);

  // Wire message handlers and slash command/component routers
  registerMiddleware(client, config);
  registerInteractionRouter(client, config, gateway);
}

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
  const runtime = createDiscordRuntime(config, dc, gateway);

  // Wire access control config into handlers/
  setAccessControl({
    allowedUsers: dc.allowedUsers,
    allowedGuilds: dc.allowedGuilds,
    allowedChannels: dc.allowedChannels,
    adminUserIds: dc.adminUserIds,
    respondMode: dc.respondMode,
  });

  const context: ContextManager = {
    acquire: (chatId: number, stringId?: string) =>
      gateway.setContext(chatId, stringId, "discord"),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  return {
    name: "discord",
    context,
    sendTyping: (chatId) => sendTyping(runtime, chatId),
    sendMessage: (chatId, text) => sendMessage(runtime, chatId, text),
    getBridgePort: () => gateway.getPort(),
    init: () => init(runtime),
    start: () => connect(runtime),
    stop: () => disconnect(runtime),
  };
}
