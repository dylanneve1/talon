/**
 * Discord frontend runtime — the state every module of this frontend shares.
 *
 * `createDiscordFrontend` used to hold the client and config as closure
 * variables with every gateway-event handler nested inside `init`. It is
 * now one explicit object, constructed once, that each module (ready,
 * guild-policy, diagnostics, outbound, connection) takes as its first
 * parameter. The runtime carries state only; the modules own the behaviour.
 */

import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { TalonConfig } from "../../core/config/index.js";
import type { Gateway } from "../../core/engine/gateway.js";

/** `config.discord`, narrowed once — the factory refuses to build without it. */
export type DiscordConfig = NonNullable<TalonConfig["discord"]>;

export type DiscordRuntime = {
  readonly config: TalonConfig;
  readonly discord: DiscordConfig;
  readonly gateway: Gateway;
  readonly client: Client;
};

function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    // Partials.Reaction is what makes reactions on messages that predate the
    // current cache arrive at all — without it the soul's reaction tap only
    // ever sees freshly-cached messages.
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.Reaction,
    ],
    allowedMentions: { parse: [] }, // never ping anyone unless we explicitly opt in
  });
}

export function createDiscordRuntime(
  config: TalonConfig,
  discord: DiscordConfig,
  gateway: Gateway,
): DiscordRuntime {
  return { config, discord, gateway, client: createClient() };
}
