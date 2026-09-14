/**
 * Guild whitelist enforcement — the bot only operates in `allowedGuilds`.
 *
 * Two entry points: the sweep run once at ready (defense in depth against
 * guilds joined while the bot was offline) and the `guildCreate` handler
 * that reacts the moment the bot is added somewhere. Both tell the admins
 * and, when `leaveUnauthorizedGuilds` is set, leave.
 */

import type { Client, Guild } from "discord.js";
import { log, logError, logWarn } from "../../util/log.js";
import { registerCommandsForGuilds } from "./commands/index.js";
import type { DiscordRuntime } from "./runtime.js";

async function notifyAdmins(
  client: Client,
  adminUserIds: readonly string[],
  content: string,
): Promise<void> {
  for (const adminId of adminUserIds) {
    try {
      const admin = await client.users.fetch(adminId);
      await admin.send({ content, allowedMentions: { parse: [] } });
    } catch {
      /* ignore */
    }
  }
}

async function leaveGuild(guild: Guild): Promise<void> {
  try {
    await guild.leave();
  } catch (err) {
    logWarn(
      "discord",
      `Failed to leave guild ${guild.id}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Ready-time sweep: leave every guild the bot is in that isn't whitelisted. */
export async function leaveNonWhitelistedGuilds(
  runtime: DiscordRuntime,
  client: Client<true>,
): Promise<void> {
  const dc = runtime.discord;
  for (const guild of client.guilds.cache.values()) {
    if (dc.allowedGuilds.includes(guild.id)) continue;
    log(
      "discord",
      `Leaving non-whitelisted guild "${guild.name}" (${guild.id})`,
    );
    await notifyAdmins(
      client,
      dc.adminUserIds,
      `🚪 Leaving non-whitelisted guild "${guild.name}" (${guild.id}).`,
    );
    await leaveGuild(guild);
  }
}

/** guildCreate: bot was added to a new guild → enforce whitelist immediately. */
export async function onGuildCreate(
  runtime: DiscordRuntime,
  guild: Guild,
): Promise<void> {
  const { client, config, discord: dc } = runtime;
  if (dc.allowedGuilds.includes(guild.id)) {
    log("discord", `Joined whitelisted guild "${guild.name}" (${guild.id})`);
    // Re-register commands for this guild
    try {
      await registerCommandsForGuilds(client, config);
    } catch (err) {
      logError("discord", `Re-register commands after guildCreate failed`, err);
    }
    return;
  }
  log("discord", `Joined non-whitelisted guild "${guild.name}" (${guild.id})`);
  await notifyAdmins(
    client,
    dc.adminUserIds,
    dc.leaveUnauthorizedGuilds
      ? `🚨 Bot was added to non-whitelisted guild "${guild.name}" (${guild.id}). Leaving.`
      : `⚠️ Bot was added to non-whitelisted guild "${guild.name}" (${guild.id}). Commands will not be registered.`,
  );
  if (dc.leaveUnauthorizedGuilds) {
    await leaveGuild(guild);
  }
}
