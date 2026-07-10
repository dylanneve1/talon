/**
 * Admin + maintenance commands — /restart, /metrics, /dream, /admin.
 * All gate on `isAdmin`.
 */

import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import type { TalonConfig } from "../../../util/config.js";
import type { Gateway } from "../../../core/engine/gateway.js";
import { respawnSelf } from "../../../util/respawn.js";
import { forceDream } from "../../../core/background/dream.js";
import { formatDuration, renderMetricsMessages } from "../helpers.js";
import { getMetrics, getTodayMetrics } from "../../../util/metrics.js";
import { handleAdminSubcommand } from "../admin.js";
import { isAdmin } from "../handlers/index.js";
import { suppressMentions, DISCORD_MAX_TEXT } from "../formatting.js";
import { reply } from "./shared.js";

export async function handleRestart(
  i: ChatInputCommandInteraction,
): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  await reply(i, "♻️ Restarting...", true);
  respawnSelf("discord /restart");
}

export async function handleMetrics(
  i: ChatInputCommandInteraction,
): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  // Ephemeral — admin counters (token usage, latencies, errors) shouldn't leak
  // into a public channel where non-admins can read them.
  const messages = [
    ...renderMetricsMessages(getMetrics()),
    ...renderMetricsMessages(
      getTodayMetrics(),
      undefined,
      "📊 Metrics — today (UTC)",
    ),
  ];
  for (const m of messages) {
    await reply(i, m, true);
  }
}

export async function handleDream(
  i: ChatInputCommandInteraction,
): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply("🌙 Dream mode starting...");
  const start = Date.now();
  forceDream()
    .then(async () => {
      const elapsed = formatDuration(Date.now() - start);
      await i.editReply(
        `🌙 Dream complete — memory consolidated in ${elapsed}.`,
      );
    })
    .catch(async (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      await i.editReply(`🌙 Dream failed: ${msg}`);
    });
}

export async function handleAdmin(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  const sub = i.options.getString("sub", true);
  const args = i.options.getString("args") ?? "";
  // Ephemeral — admin subcommands surface operational data (chat lists, logs,
  // cron, daily logs) that shouldn't leak into the channel for non-admins.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await handleAdminSubcommand(sub, args, config, gateway, async (text) => {
    await i.followUp({
      content: suppressMentions(text).slice(0, DISCORD_MAX_TEXT),
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
  });
}
