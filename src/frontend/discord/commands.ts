/**
 * Discord slash commands — equivalent to src/frontend/telegram/commands.ts.
 *
 * Registration strategy (the heart of access control for slash commands):
 *  - Slash commands are registered as guild-specific in every guild on
 *    config.discord.allowedGuilds → instant propagation, hidden everywhere else.
 *  - When config.discord.enableDmCommands is true, the same set is ALSO
 *    registered globally with dm_permission, so users on allowedUsers can run
 *    them in DMs. We still enforce allowedUsers at execution time so a global
 *    registration leak can't be abused.
 *  - For guilds the bot is in but which are NOT on allowedGuilds, we wipe their
 *    guild commands on startup (and on guildCreate). Combined with the optional
 *    leaveUnauthorizedGuilds flag, this guarantees commands aren't visible
 *    where they shouldn't be.
 *
 * Slash command surface mirrors Telegram: /start /help /settings /memory
 * /status /ping /model /effort /pulse /reset /restart /metrics /dream /plugins
 * /admin <subcommand>.
 */

import { respawnSelf } from "../../util/respawn.js";
import { readFileSync, existsSync } from "node:fs";
import {
  type Client,
  type ChatInputCommandInteraction,
  type Interaction,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} from "discord.js";
import type { TalonConfig } from "../../util/config.js";
import type { Gateway } from "../../core/gateway.js";
import { files } from "../../util/paths.js";
import {
  resetSession,
  getSessionInfo,
  getActiveSessionCount,
} from "../../storage/sessions.js";
import { clearHistory } from "../../storage/history.js";
import {
  getChatSettings,
  setChatModelForBackend,
  setChatBackend,
  setChatEffort,
  setChatPulseInterval,
  resolveModelName,
  type EffortLevel,
} from "../../storage/chat-settings.js";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
  resetPulseCheckpoint,
} from "../../core/pulse.js";
import { forceDream } from "../../core/dream.js";
import { getWorkspaceDiskUsage } from "../../util/workspace.js";
import { appendDailyLog } from "../../storage/daily-log.js";
import {
  formatModelLabel,
  formatDuration,
  formatTokenCount,
  formatBytes,
  parseInterval,
  renderMetricsMessages,
  renderSettingsText,
  EFFORT_DESCRIPTIONS,
} from "./helpers.js";
import { getLoadedPlugins } from "../../core/plugin.js";
import { getMetrics } from "../../util/metrics.js";
import { handleAdminSubcommand } from "./admin.js";
import { buildCacheDisplay, buildContextDisplay } from "../status-context.js";
import {
  displayReasoningEffort,
  getActiveReasoningLevels,
  supportsReasoningLevel,
} from "../reasoning-levels.js";
import {
  isAdmin,
  isInteractionAllowed,
  registerDiscordChat,
} from "./handlers.js";
import { deriveNumericChatId } from "../../util/chat-id.js";
import {
  getBackendIdForChat,
  resolveChatBackend,
} from "../../core/backend-controller.js";
import { resolveActiveModelForChat } from "../../core/active-model.js";

import { log, logError, logWarn } from "../../util/log.js";
import {
  suppressMentions,
  splitMessage,
  safeSlice,
  DISCORD_MAX_TEXT,
  DISCORD_SAFE_RESERVE,
} from "./formatting.js";

// ── Slash command definitions ───────────────────────────────────────────────

function buildCommandDefinitions(): unknown[] {
  return [
    new SlashCommandBuilder()
      .setName("start")
      .setDescription("Introduction to Talon")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("All commands and features")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("settings")
      .setDescription("View and change all chat settings")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("memory")
      .setDescription("View what Talon remembers")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Session info, usage, and stats")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Health check with latency")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Show or change the model")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Model name or 'reset'")
          .setRequired(false)
          .setAutocomplete(true),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("effort")
      .setDescription("Set thinking effort level")
      .addStringOption((o) =>
        o
          .setName("level")
          .setDescription("Effort level")
          .setRequired(false)
          .addChoices(
            { name: "off", value: "off" },
            { name: "low", value: "low" },
            { name: "medium", value: "medium" },
            { name: "high", value: "high" },
            { name: "max", value: "max" },
            { name: "adaptive", value: "adaptive" },
          ),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("pulse")
      .setDescription("Toggle periodic check-ins")
      .addStringOption((o) =>
        o
          .setName("arg")
          .setDescription("on, off, or interval (e.g. 30m, 2h)")
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("reset")
      .setDescription("Clear session and start fresh")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("restart")
      .setDescription("Restart the bot (admin only)")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("metrics")
      .setDescription("Aggregate performance metrics (admin)")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("dream")
      .setDescription("Force memory consolidation (admin)")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("plugins")
      .setDescription("List loaded plugins")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("admin")
      .setDescription("Admin operations (admin only)")
      .addStringOption((o) =>
        o
          .setName("sub")
          .setDescription("Subcommand")
          .setRequired(true)
          .addChoices(
            { name: "stats", value: "stats" },
            { name: "errors", value: "errors" },
            { name: "chats", value: "chats" },
            { name: "daily", value: "daily" },
            { name: "pulse", value: "pulse" },
            { name: "cron", value: "cron" },
            { name: "logs", value: "logs" },
          ),
      )
      .addStringOption((o) =>
        o.setName("args").setDescription("Extra arguments").setRequired(false),
      )
      .toJSON(),
  ];
}

// ── Registration: per-guild + optional global for DM ────────────────────────

export async function registerCommandsForGuilds(
  client: Client,
  config: TalonConfig,
): Promise<void> {
  const dc = config.discord!;
  const rest = new REST({ version: "10" }).setToken(dc.botToken);
  const definitions = buildCommandDefinitions();

  // Step 1: clear or set global commands depending on DM setting.
  try {
    if (dc.enableDmCommands) {
      // Add a dm_permission flag to the JSON before sending.
      const dmDefs = definitions.map((d) => ({
        ...(d as Record<string, unknown>),
        dm_permission: true,
      }));
      await rest.put(Routes.applicationCommands(dc.applicationId), {
        body: dmDefs,
      });
      log(
        "discord",
        `Registered ${dmDefs.length} global commands (DM-enabled)`,
      );
    } else {
      await rest.put(Routes.applicationCommands(dc.applicationId), {
        body: [],
      });
      log("discord", "Cleared global commands (DM commands disabled)");
    }
  } catch (err) {
    logError("discord", "Failed to register/clear global commands", err);
  }

  // Step 2: per-guild registration in allowedGuilds (instant propagation,
  // immediately visible only there). We do this even when global is enabled,
  // so users see the commands instantly inside whitelisted servers.
  for (const guildId of dc.allowedGuilds) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(dc.applicationId, guildId),
        { body: definitions },
      );
      log(
        "discord",
        `Registered ${definitions.length} commands in guild ${guildId}`,
      );
    } catch (err) {
      logError(
        "discord",
        `Failed to register commands in guild ${guildId}`,
        err,
      );
    }
  }

  // Step 3: in any guild the bot is currently in but NOT on allowedGuilds,
  // wipe guild-specific commands (defense in depth).
  for (const guild of client.guilds.cache.values()) {
    if (dc.allowedGuilds.includes(guild.id)) continue;
    try {
      await rest.put(
        Routes.applicationGuildCommands(dc.applicationId, guild.id),
        { body: [] },
      );
      log(
        "discord",
        `Cleared commands in non-whitelisted guild ${guild.id} (${guild.name})`,
      );
    } catch (err) {
      logWarn(
        "discord",
        `Failed to clear commands in guild ${guild.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

// ── Interaction routing ─────────────────────────────────────────────────────

export function registerInteractionRouter(
  client: Client,
  config: TalonConfig,
  gateway: Gateway,
): void {
  client.on("interactionCreate", async (interaction: Interaction) => {
    try {
      // Slash commands
      if (interaction.isChatInputCommand()) {
        await routeSlashCommand(interaction, config, gateway);
        return;
      }
      // Autocomplete for /model name:
      if (interaction.isAutocomplete()) {
        const { handleAutocomplete } = await import("./callbacks.js");
        await handleAutocomplete(interaction, gateway);
        return;
      }
      // Buttons & select menus → callbacks.ts handler
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const { handleComponentInteraction } = await import("./callbacks.js");
        await handleComponentInteraction(interaction, config, gateway);
        return;
      }
      // Modal submissions (pulse interval)
      if (interaction.isModalSubmit()) {
        const { handleModalSubmit } = await import("./callbacks.js");
        await handleModalSubmit(interaction, config, gateway);
        return;
      }
    } catch (err) {
      logError("discord", "Interaction handling failed", err);
      try {
        if (
          interaction.isRepliable() &&
          !interaction.replied &&
          !interaction.deferred
        ) {
          await interaction.reply({
            content: "Something went wrong handling that interaction.",
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        /* ignore */
      }
    }
  });
}

// ── Helpers used by slash command handlers ──────────────────────────────────

function chatIdFromInteraction(interaction: ChatInputCommandInteraction): {
  chatId: string;
  numericChatId: number;
} {
  const chatId = interaction.guildId
    ? `discord_guild_${interaction.guildId}_${interaction.channelId}`
    : `discord_dm_${interaction.user.id}`;
  return { chatId, numericChatId: deriveNumericChatId(chatId) };
}

async function reply(
  interaction: ChatInputCommandInteraction,
  content: string,
  ephemeral = false,
): Promise<void> {
  const safe = suppressMentions(content);
  const chunks = splitMessage(safe, DISCORD_MAX_TEXT);
  const baseOpts = {
    allowedMentions: { parse: [] as never[] },
  };
  const opts = ephemeral
    ? { ...baseOpts, flags: MessageFlags.Ephemeral as const }
    : baseOpts;
  if (!interaction.deferred && !interaction.replied) {
    await interaction.reply({ content: chunks[0], ...opts });
  } else {
    await interaction.followUp({ content: chunks[0], ...opts });
  }
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i], ...opts });
  }
}

// ── Main slash command router ───────────────────────────────────────────────

async function routeSlashCommand(
  interaction: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
): Promise<void> {
  // Access control — same as message handler, but synchronous decision.
  const access = isInteractionAllowed(
    interaction.inGuild(),
    interaction.user.id,
    interaction.guildId,
    interaction.channelId,
  );
  if (!access.ok) {
    await interaction.reply({
      content: `⚠️ ${access.reason}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Register chat in the registry so action handler can resolve channel later.
  const { chatId, numericChatId } = chatIdFromInteraction(interaction);
  registerDiscordChat({
    channelId: interaction.channelId!,
    guildId: interaction.guildId,
    userId: interaction.guildId ? null : interaction.user.id,
    numericChatId,
    chatId,
  });

  switch (interaction.commandName) {
    case "start":
      return handleStart(interaction);
    case "help":
      return handleHelp(interaction, client(interaction));
    case "settings":
      return handleSettings(interaction, config, gateway, chatId);
    case "memory":
      return handleMemory(interaction);
    case "status":
      return handleStatus(interaction, config, gateway, chatId);
    case "ping":
      return handlePing(interaction);
    case "model":
      return handleModel(interaction, config, gateway, chatId);
    case "effort":
      return handleEffort(interaction, config, gateway, chatId);
    case "pulse":
      return handlePulse(interaction, chatId);
    case "reset":
      return handleReset(interaction, gateway, chatId);
    case "restart":
      return handleRestart(interaction);
    case "metrics":
      return handleMetrics(interaction);
    case "dream":
      return handleDream(interaction);
    case "plugins":
      return handlePlugins(interaction);
    case "admin":
      return handleAdmin(interaction, config, gateway);
    default:
      await reply(interaction, "Unknown command.", true);
  }
}

function client(i: ChatInputCommandInteraction) {
  return i.client;
}

// ── Individual command handlers ─────────────────────────────────────────────

async function handleStart(i: ChatInputCommandInteraction): Promise<void> {
  await reply(
    i,
    [
      "**🦅 Talon**",
      "",
      "Agentic AI harness for Discord.",
      "",
      "Mention me, reply to me, or DM me. Attach files, photos, voice notes — I'll read them.",
      "",
      "/status  /reset  /help",
    ].join("\n"),
  );
}

async function handleHelp(
  i: ChatInputCommandInteraction,
  c: Client,
): Promise<void> {
  const botMention = c.user ? `<@${c.user.id}>` : "@bot";
  await reply(
    i,
    [
      "**🦅 Talon — Help**",
      "",
      "**Settings**",
      "  /settings — view and change all chat settings",
      "  /model — show or change model",
      "  /effort — set thinking effort (off, low, medium, high, max)",
      "  /pulse — toggle periodic check-ins (on/off)",
      "",
      "**Session**",
      "  /status — session info, usage, and stats",
      "  /metrics — aggregate performance metrics (admin)",
      "  /memory — view what Talon remembers",
      "  /dream — force memory consolidation now (admin)",
      "  /ping — health check with latency",
      "  /reset — clear session and start fresh",
      "  /restart — restart the bot process (admin)",
      "  /plugins — list loaded plugins",
      "  /help — this message",
      "",
      "**Input**",
      "  Text, photos, documents, voice notes, audio, videos, GIFs, replies, attachments.",
      "",
      "**Servers**",
      `  In a server, mention ${botMention} or reply to me to activate.`,
      "",
      "**DM**",
      "  Whitelisted users can DM me directly.",
    ].join("\n"),
    true,
  );
}

async function handleMemory(i: ChatInputCommandInteraction): Promise<void> {
  try {
    const memoryPath = files.memory;
    if (!existsSync(memoryPath)) {
      await reply(
        i,
        "No memory file yet. I'll create one as I learn about you.",
        true,
      );
      return;
    }
    const content = readFileSync(memoryPath, "utf-8").trim();
    if (!content) {
      await reply(i, "Memory file is empty. I'll update it as we chat.", true);
      return;
    }
    const budget = DISCORD_MAX_TEXT - DISCORD_SAFE_RESERVE;
    const display =
      content.length > budget
        ? content.slice(0, budget) + "\n\n... (truncated)"
        : content;
    await reply(i, display, true);
  } catch {
    await reply(i, "Could not read memory file.", true);
  }
}

async function handlePing(i: ChatInputCommandInteraction): Promise<void> {
  const start = Date.now();
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const apiLatency = Date.now() - start;
  // client.ws.ping is the WebSocket heartbeat RTT (the real gateway latency).
  const wsPing = i.client.ws.ping;
  const uptime = formatDuration(process.uptime() * 1000);
  await i.editReply(
    `Pong! WS: ${wsPing}ms · REST: ${apiLatency}ms\nGateway: ✓ | Uptime: ${uptime}`,
  );
}

async function handleReset(
  i: ChatInputCommandInteraction,
  gateway: Gateway,
  chatId: string,
): Promise<void> {
  // Defer immediately — warmSession can hit a cold backend (cold container,
  // model load) and miss the 3s interaction ACK window.
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const info = getSessionInfo(chatId);
  if (info.turns > 0) {
    const duration = info.createdAt
      ? formatDuration(Date.now() - info.createdAt)
      : "unknown";
    const modelNote =
      info.turns > 5 && info.lastModel ? ` | model: ${info.lastModel}` : "";
    const nameNote = info.sessionName ? ` "${info.sessionName}"` : "";
    appendDailyLog(
      "System",
      `Session reset${nameNote}: ${info.turns} turns, ${duration}${modelNote}`,
    );
  }
  resetSession(chatId);
  clearHistory(chatId);
  resetPulseCheckpoint(chatId);
  // Warm the per-chat backend so cold-start latency doesn't show up
  // on the next turn — must be the actual chat backend, not the
  // global default, when this chat has an override pinned.
  const chatBackend = resolveChatBackend(chatId, gateway?.backend);
  // Wipe any in-process backend memory (e.g. openai-agents'
  // MemorySession). Stateless backends ignore this.
  chatBackend?.sessions?.resetChat?.(chatId);
  await chatBackend?.sessions?.warmSession?.(chatId);
  await reply(i, "Session cleared.", true);
}

async function handleStatus(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
  chatId: string,
): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const info = getSessionInfo(chatId);
  const u = info.usage;
  const uptime = formatDuration(process.uptime() * 1000);
  const sessionAge = info.createdAt
    ? formatDuration(Date.now() - info.createdAt)
    : "—";
  const chatSets = getChatSettings(chatId);
  const statusBe = resolveChatBackend(chatId, gateway?.backend);
  const statusBeId = getBackendIdForChat(chatId);
  // Consume the resolved `ModelRef` so context window + display name
  // come from one enriched object. The ref resolver wraps the same
  // 5-step chain as `resolveActiveModelForChat`, so the active model
  // id is identical; the difference is one fewer round-trip to
  // `getRawModelInfo` for the common case.
  const { ref: statusModelRef } = await resolveActiveModelForChat(
    chatId,
    statusBe,
    statusBeId,
    config,
  );
  const activeModel = statusModelRef?.id ?? "No model selected";
  const effortName = chatSets.effort ?? "adaptive";
  const pulseOn = isPulseEnabled(chatId);

  let ctxMax = u.contextWindow;
  let displayInputTokens = u.totalInputTokens;
  let displayOutputTokens = u.totalOutputTokens;
  let displayCacheRead = u.totalCacheRead;
  let displayCacheWrite = u.totalCacheWrite;
  let turnsModelLabel = info.lastModel;

  // Backend reference for snapshot enrichment + cache support. The
  // ModelRef already carries the active model's `contextWindow`, so
  // we no longer need the separate `getModelInfo(activeModel)` call
  // here.
  const be = statusBe;
  if (statusModelRef?.contextWindow) {
    ctxMax = ctxMax || statusModelRef.contextWindow;
  }
  if (be?.usage?.getSessionSnapshot && info.sessionId) {
    const snap = await be.usage
      ?.getSessionSnapshot(info.sessionId)
      .catch(() => undefined);
    if (snap) {
      displayInputTokens = snap.inputTokens ?? displayInputTokens;
      displayOutputTokens = snap.outputTokens ?? displayOutputTokens;
      displayCacheRead = snap.cacheRead ?? displayCacheRead;
      displayCacheWrite = snap.cacheWrite ?? displayCacheWrite;
      if (snap.contextModelId) turnsModelLabel = snap.contextModelId;
    }
  }

  const cache = buildCacheDisplay({
    cacheMetrics: be?.cacheMetrics,
    inputTokens: displayInputTokens,
    cacheRead: displayCacheRead,
    cacheWrite: displayCacheWrite,
  });

  const context = buildContextDisplay({
    contextTokens: u.contextTokens,
    lastPromptTokens: u.lastPromptTokens,
    contextWindow: ctxMax,
  });
  const contextWarn = context.warn ? " ⚠️ consider /reset" : "";
  const contextUsedText = context.known
    ? formatTokenCount(context.used)
    : "unknown";
  const contextMaxText =
    context.max > 0 ? formatTokenCount(context.max) : "unknown";
  const avgResponseMs =
    info.turns > 0 && u.totalResponseMs
      ? Math.round(u.totalResponseMs / info.turns)
      : 0;
  const lastResponseMs = u.lastResponseMs || 0;
  const fastestMs =
    u.fastestResponseMs === Infinity ? 0 : u.fastestResponseMs || 0;
  const diskBytes = getWorkspaceDiskUsage(config.workspace);
  const diskStr = formatBytes(diskBytes);

  const backendLabel = be?.label ?? "";
  const lines = [
    `**🦅 Talon** · \`${formatModelLabel(activeModel)}\`${backendLabel ? ` · *${backendLabel}*` : ""} · effort: ${effortName}`,
    "",
    `**Context** ${contextUsedText} / ${contextMaxText} (${context.known ? `${context.pct}%` : "unknown"})${contextWarn}`,
    `\`${context.bar}\``,
    "",
    "**Session Stats**",
    `  Response  last ${lastResponseMs ? formatDuration(lastResponseMs) : "—"} · avg ${avgResponseMs ? formatDuration(avgResponseMs) : "—"} · best ${fastestMs ? formatDuration(fastestMs) : "—"}`,
    `  Turns     ${info.turns}${turnsModelLabel ? ` (${formatModelLabel(turnsModelLabel)})` : ""}`,
    "",
    ...(cache
      ? [
          `**Cache**     ${cache.hitPct}% hit`,
          `  Read ${formatTokenCount(cache.read)}${cache.showsWrite ? `  Write ${formatTokenCount(cache.write)}` : ""}`,
        ]
      : []),
    `  Input ${formatTokenCount(displayInputTokens)}  Output ${formatTokenCount(displayOutputTokens)}`,
    "",
    `**Pulse**  ${pulseOn ? "on" : "off"}`,
    `**Workspace**  ${diskStr}`,
    `**Session**   ${info.sessionName ? `"${info.sessionName}" ` : ""}${info.sessionId ? "`" + info.sessionId.slice(0, 8) + "...`" : "_(new)_"} · ${sessionAge} old`,
    `**Uptime**    ${uptime} · ${getActiveSessionCount()} active session${getActiveSessionCount() === 1 ? "" : "s"}`,
  ];
  await i.editReply(lines.join("\n"));
}

async function handleModel(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
  chatId: string,
): Promise<void> {
  // Defer immediately — getSettingsPresentation / resolveModel can hit a cold
  // backend and exceed the 3s interaction ACK window.
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const arg = i.options.getString("name")?.trim();
  // Per-chat backend — /model picks for the backend serving *this*
  // chat, override-aware. Without this, switching to openai-agents
  // in one channel and running /model in another would show the
  // wrong catalog.
  const be = resolveChatBackend(chatId, gateway?.backend);
  const beId = getBackendIdForChat(chatId);
  const { model: resolvedActive } = await resolveActiveModelForChat(
    chatId,
    be,
    beId,
    config,
  );
  const activeModel = resolvedActive ?? "";

  if (
    !arg ||
    arg.toLowerCase() === "reset" ||
    arg.toLowerCase() === "default"
  ) {
    if (arg) {
      setChatModelForBackend(chatId, beId, undefined);
      const { model: postResetModel } = await resolveActiveModelForChat(
        chatId,
        be,
        beId,
        config,
      );
      const msg = postResetModel
        ? `Model reset to default: \`${postResetModel}\``
        : `Model reset — no default available for backend \`${beId}\`. Use /model to pick one.`;
      await reply(i, msg, true);
      return;
    }
    if (be?.models?.getSettingsPresentation) {
      const pres = await be.models?.getSettingsPresentation(activeModel, {
        callbackPrefix: "model:",
      });
      const modelInfo = activeModel
        ? await be.models?.getRawModelInfo?.(activeModel)
        : undefined;
      const displayName =
        modelInfo?.displayName ??
        (activeModel ? formatModelLabel(activeModel) : "_No model selected_");

      // Build select menu from the top 25 models. Discord caps select-menu
      // options at 25; if the backend exposes more, use `/model name:<value>`
      // (autocomplete-backed) to pick anything outside this list.
      const options = pres.modelButtons.slice(0, 25).map((b) => ({
        label: safeSlice(b.text.replace(/^✓ /, ""), 100),
        value: safeSlice(b.callback_data.replace(/^model:/, ""), 100),
        default: b.text.startsWith("✓"),
      }));
      const menu = new StringSelectMenuBuilder()
        .setCustomId("model:select")
        .setPlaceholder("Pick a model")
        .addOptions(options);
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        menu,
      );
      const lines = [`**Model:** \`${displayName}\``, ...pres.modelDetails];
      await i.editReply({
        content: lines.join("\n"),
        components: [row],
        allowedMentions: { parse: [] },
      });
    } else {
      await reply(i, `**Model:** \`${formatModelLabel(activeModel)}\``, true);
    }
    return;
  }

  if (be?.models?.resolveModelInfo) {
    const resolution = await be.models?.resolveModelInfo(arg);
    if (resolution.kind !== "exact") {
      const msg =
        be.models?.formatModelError?.(arg, resolution) ??
        `No model matched "${arg}".`;
      await reply(i, msg, true);
      return;
    }
    if (!resolution.model.selectable) {
      const msg =
        resolution.model.unavailableReason ??
        `${resolution.model.providerName} is not connected.`;
      await reply(i, msg, true);
      return;
    }
    setChatModelForBackend(chatId, beId, resolution.storedValue);
    setChatBackend(chatId, beId);
    await reply(
      i,
      `Model set to \`${resolution.storedValue}\` (${resolution.model.providerName}${resolution.model.free ? " · free" : ""}).`,
      true,
    );
  } else {
    const model = resolveModelName(arg);
    setChatModelForBackend(chatId, beId, model);
    setChatBackend(chatId, beId);
    await reply(i, `Model set to \`${formatModelLabel(model)}\`.`, true);
  }
}

async function handleEffort(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
  chatId: string,
): Promise<void> {
  const level = i.options.getString("level")?.toLowerCase();
  const settings = getChatSettings(chatId);
  const be = resolveChatBackend(chatId, gateway?.backend);
  const beId = getBackendIdForChat(chatId);
  const reasoning = await getActiveReasoningLevels({
    chatId,
    backend: be,
    backendId: beId,
    config,
  });

  if (reasoning.levels.length === 0) {
    await reply(
      i,
      `No valid reasoning levels found for the active model on backend \`${beId}\`.`,
      true,
    );
    return;
  }

  if (!level) {
    const current = displayReasoningEffort(settings.effort, reasoning.levels);
    const options = [...reasoning.levels, "adaptive"].map((v) => ({
      label: v,
      value: v,
      description: EFFORT_DESCRIPTIONS[v],
      default: current === v,
    }));
    const menu = new StringSelectMenuBuilder()
      .setCustomId("effort:select")
      .setPlaceholder(`Current: ${current}`)
      .addOptions(options);
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      menu,
    );
    await i.reply({
      content: `**Effort:** ${current}`,
      components: [row],
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (level === "adaptive") {
    setChatEffort(chatId, undefined);
    await reply(
      i,
      "Effort reset to **adaptive** (model decides when to think)",
      true,
    );
    return;
  }
  if (supportsReasoningLevel(level, reasoning.levels)) {
    setChatEffort(chatId, level as EffortLevel);
    await reply(i, `Effort set to **${level}**`, true);
    return;
  }
  await reply(
    i,
    `Unknown level for this model. Valid: ${reasoning.levels.join(", ")}, or adaptive.`,
    true,
  );
}

async function handlePulse(
  i: ChatInputCommandInteraction,
  chatId: string,
): Promise<void> {
  const arg = i.options.getString("arg")?.trim().toLowerCase();

  if (!arg || arg === "status") {
    const enabled = isPulseEnabled(chatId);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("pulse:on")
        .setLabel(enabled ? "✓ On" : "On")
        .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("pulse:off")
        .setLabel(!enabled ? "✓ Off" : "Off")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("pulse:interval")
        .setLabel("Set interval…")
        .setStyle(ButtonStyle.Secondary),
    );
    await i.reply({
      content: [
        `**🔔 Pulse:** ${enabled ? "on" : "off"}`,
        "",
        "Reads along every few minutes and jumps in when there's something to add.",
      ].join("\n"),
      components: [row],
      allowedMentions: { parse: [] },
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (arg === "on" || arg === "enable") {
    enablePulse(chatId);
    registerChat(chatId);
    await reply(i, "🔔 Pulse enabled.", true);
    return;
  }
  if (arg === "off" || arg === "disable") {
    disablePulse(chatId);
    await reply(i, "🔔 Pulse disabled.", true);
    return;
  }
  const intervalMs = parseInterval(arg);
  if (intervalMs && intervalMs >= 5 * 60 * 1000) {
    setChatPulseInterval(chatId, intervalMs);
    enablePulse(chatId);
    registerChat(chatId);
    await reply(
      i,
      `🔔 Pulse cooldown set to **${formatDuration(intervalMs)}**`,
      true,
    );
    return;
  }
  if (intervalMs) {
    await reply(i, "Minimum interval is 5 minutes.", true);
    return;
  }
  await reply(i, "Use: /pulse on, /pulse off, /pulse 30m, /pulse 2h", true);
}

async function handleSettings(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
  chatId: string,
): Promise<void> {
  // Defer immediately — getSettingsPresentation hits the backend.
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  const chatSets = getChatSettings(chatId);
  const settingsBe = resolveChatBackend(chatId, gateway?.backend);
  const settingsBeId = getBackendIdForChat(chatId);
  const { model: resolvedActive } = await resolveActiveModelForChat(
    chatId,
    settingsBe,
    settingsBeId,
    config,
  );
  const activeModel = resolvedActive ?? "No model selected";
  const pulseOn = isPulseEnabled(chatId);
  const reasoning = await getActiveReasoningLevels({
    chatId,
    backend: settingsBe,
    backendId: settingsBeId,
    config,
  });
  const effortName = displayReasoningEffort(chatSets.effort, reasoning.levels);

  let modelDetails: Array<string> | undefined;
  let modelButtons: Array<{ text: string; callback_data: string }> | undefined;
  // `settingsBe` already resolved above for the activeModel lookup;
  // reuse it for the catalog snapshot. Pass the raw resolved id (or
  // empty string) — never the "No model selected" sentinel.
  if (settingsBe?.models?.getSettingsPresentation) {
    const presModelId = resolvedActive ?? "";
    const presentation =
      await settingsBe.models?.getSettingsPresentation(presModelId);
    modelDetails = presentation.modelDetails;
    modelButtons = presentation.modelButtons;
  }

  // Build components: model select menu, effort select menu, pulse toggle, done.
  const components: ActionRowBuilder<
    StringSelectMenuBuilder | ButtonBuilder
  >[] = [];

  if (modelButtons?.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("settings:model")
      .setPlaceholder("Select a model")
      .addOptions(
        modelButtons.slice(0, 25).map((b) => ({
          label: safeSlice(b.text.replace(/^✓ /, ""), 100),
          value: safeSlice(
            b.callback_data.replace(/^settings:model:/, ""),
            100,
          ),
          default: b.text.startsWith("✓"),
        })),
      );
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    );
  }

  if (reasoning.levels.length > 0) {
    const effortMenu = new StringSelectMenuBuilder()
      .setCustomId("settings:effort:select")
      .setPlaceholder(`Effort: ${effortName}`)
      .addOptions(
        [...reasoning.levels, "adaptive"].map((v) => ({
          label: v,
          value: v,
          description: EFFORT_DESCRIPTIONS[v],
          default: effortName === v,
        })),
      );
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(effortMenu),
    );
  }

  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`settings:proactive:${pulseOn ? "off" : "on"}`)
        .setLabel(pulseOn ? "Pulse: ON" : "Pulse: OFF")
        .setStyle(pulseOn ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("settings:done")
        .setLabel("Done")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  await i.editReply({
    content: renderSettingsText(
      activeModel,
      effortName,
      pulseOn,
      chatSets.pulseIntervalMs,
      modelDetails,
    ),
    components,
    allowedMentions: { parse: [] },
  });
}

async function handleRestart(i: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  await reply(i, "♻️ Restarting...", true);
  respawnSelf("discord /restart");
}

async function handleMetrics(i: ChatInputCommandInteraction): Promise<void> {
  if (!isAdmin(i.user.id)) {
    await reply(i, "Not authorized.", true);
    return;
  }
  // Ephemeral — admin counters (token usage, latencies, errors) shouldn't leak
  // into a public channel where non-admins can read them.
  const messages = renderMetricsMessages(getMetrics());
  for (const m of messages) {
    await reply(i, m, true);
  }
}

async function handleDream(i: ChatInputCommandInteraction): Promise<void> {
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

async function handlePlugins(i: ChatInputCommandInteraction): Promise<void> {
  const plugins = getLoadedPlugins();
  if (plugins.length === 0) {
    await reply(i, "No plugins loaded.", true);
    return;
  }
  const lines = plugins.map((p) => {
    const ver = p.plugin.version ? ` v${p.plugin.version}` : "";
    const desc = p.plugin.description ? ` — ${p.plugin.description}` : "";
    const mcp = p.plugin.mcpServerPath ? " [MCP]" : "";
    const fe = p.plugin.frontends?.length
      ? ` (${p.plugin.frontends.join(", ")})`
      : "";
    return `• **${p.plugin.name}**${ver}${mcp}${fe}${desc}`;
  });
  await reply(
    i,
    `**Plugins (${plugins.length})**\n\n${lines.join("\n")}`,
    true,
  );
}

async function handleAdmin(
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
