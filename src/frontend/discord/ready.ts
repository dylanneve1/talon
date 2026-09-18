/**
 * The `clientReady` handler — everything that needs a logged-in client:
 * presence, DM discovery for the chat registry, slash-command registration,
 * and the guild whitelist sweep.
 */

import { ActivityType, type Client } from "discord.js";
import { log, logError } from "../../util/log.js";
import { deriveNumericChatId } from "../../core/frontend-runtime/chat-id.js";
import { registerCommandsForGuilds } from "./commands/index.js";
import { registerDiscordChat } from "./handlers/index.js";
import { leaveNonWhitelistedGuilds } from "./guild-policy.js";
import type { DiscordRuntime } from "./runtime.js";

/**
 * Discover any existing DM channels with allowedUsers and register them in
 * the chat registry so cron/pulse can target them. We don't pre-open
 * unrequested DMs — only those Discord already exposes.
 */
async function registerAllowedUserDms(
  runtime: DiscordRuntime,
  client: Client<true>,
): Promise<void> {
  for (const userId of runtime.discord.allowedUsers) {
    try {
      const user = await client.users.fetch(userId);
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
}

export async function onClientReady(
  runtime: DiscordRuntime,
  client: Client<true>,
): Promise<void> {
  const { config, discord: dc } = runtime;
  log("discord", `Logged in as ${client.user.tag} (${client.user.id})`);

  if (dc.presence) {
    try {
      client.user.setPresence({
        activities: [{ name: dc.presence, type: ActivityType.Custom }],
        status: "online",
      });
    } catch {
      /* ignore */
    }
  }

  await registerAllowedUserDms(runtime, client);

  // Register slash commands per-guild + optionally global for DM
  try {
    await registerCommandsForGuilds(client, config);
  } catch (err) {
    logError("discord", "Slash command registration failed", err);
  }

  // Defense in depth: leave any guild we're in but isn't whitelisted
  if (dc.leaveUnauthorizedGuilds) {
    await leaveNonWhitelistedGuilds(runtime, client);
  }
}
