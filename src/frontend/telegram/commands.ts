/**
 * All /command handlers for the Telegram bot.
 */

import type { Bot } from "grammy";
import { readFileSync, existsSync } from "node:fs";
import { respawnSelf } from "../../util/respawn.js";
import type { TalonConfig } from "../../util/config.js";
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
} from "../../core/background/pulse.js";
import { forceDream } from "../../core/background/dream.js";
import { isUserClientReady } from "./userbot.js";
import { getWorkspaceDiskUsage } from "../../util/workspace.js";
import { appendDailyLog } from "../../storage/daily-log.js";
import { escapeHtml } from "./formatting.js";
import { closestMatch } from "../../native/strsim.js";
import {
  formatModelLabel,
  formatDuration,
  formatTokenCount,
  formatBytes,
  parseInterval,
  renderDoctorMessage,
  renderMetricsMessages,
  renderSettingsText,
  renderSettingsKeyboard,
  renderEffortRows,
  renderModelMenuText,
  renderModelMenuKeyboard,
  type SettingsButton,
} from "./helpers.js";
import {
  buildModelMenuViewForChat,
  resolveBackendForChat,
} from "./model-menu.js";
import { getBackendIdForChat } from "../../core/engine/backend-controller.js";
import { collectDoctorReport } from "../../core/doctor.js";
import { resolveActiveModelForChat } from "../../core/models/active-model.js";

import {
  displayReasoningEffort,
  getActiveReasoningLevels,
  supportsReasoningLevel,
} from "../shared/reasoning-levels.js";
import { handleAdminCommand } from "./admin.js";
import { getLoadedPlugins } from "../../core/plugin.js";
import { getMetrics } from "../../util/metrics.js";
import {
  buildCacheDisplay,
  buildContextDisplay,
} from "../shared/status-context.js";

// Admin user ID is set via talon.json or TALON_ADMIN_USER_ID env var
let ADMIN_USER_ID = 0;

/**
 * User-facing command menu — the single source for Telegram's command
 * menu (setMyCommands in index.ts) and the unknown-command suggester
 * below. Admin-only commands (/admin) stay off the menu and out of
 * suggestions deliberately.
 */
export const TELEGRAM_COMMANDS: ReadonlyArray<{
  command: string;
  description: string;
}> = [
  { command: "start", description: "Introduction" },
  {
    command: "settings",
    description: "View and change all chat settings",
  },
  { command: "memory", description: "View what Talon remembers" },
  { command: "status", description: "Session info, usage, and stats" },
  { command: "ping", description: "Health check with latency" },
  { command: "model", description: "Show or change model" },
  { command: "effort", description: "Set thinking effort level" },
  { command: "pulse", description: "Conversation engagement settings" },
  { command: "reset", description: "Clear session and start fresh" },
  { command: "restart", description: "Restart the bot (admin)" },
  { command: "metrics", description: "Aggregate performance metrics" },
  {
    command: "doctor",
    description: "Environment and native-module health",
  },
  { command: "dream", description: "Force memory consolidation" },
  { command: "plugins", description: "List loaded plugins" },
  { command: "help", description: "All commands and features" },
];

/** Set the admin user ID (called from config at startup). */
export function setAdminUserId(id: number | undefined): void {
  ADMIN_USER_ID = id ?? 0;
}

export function registerCommands(
  bot: Bot,
  config: TalonConfig,
  gateway?: {
    backend: import("../../core/agent-runtime/capabilities.js").Backend | null;
  },
): void {
  bot.command("start", (ctx) =>
    ctx.reply(
      [
        "<b>\uD83E\uDD85 Talon</b>",
        "",
        "Agentic AI harness for Telegram.",
        "",
        "Send a message, photo, doc, or voice note.",
        "In groups, @mention or reply to activate.",
        "",
        "/status  /reset  /help",
      ].join("\n"),
      { parse_mode: "HTML" },
    ),
  );

  bot.command("help", (ctx) =>
    ctx.reply(
      [
        "<b>\uD83E\uDD85 Talon -- Help</b>",
        "",
        "<b>\uD83E\uDD85 Settings</b>",
        "  /settings -- view and change all chat settings",
        "  /model -- show or change model and backend",
        "  /effort -- set thinking effort (off, low, medium, high, max)",
        "  /pulse -- toggle periodic check-ins (on/off)",
        "",
        "<b>Session</b>",
        "  /status -- session info, usage, and stats",
        "  /metrics -- aggregate performance metrics (admin)",
        "  /doctor -- environment and native-module health (admin)",
        "  /memory -- view what Talon remembers",
        "  /dream -- force memory consolidation now",
        "  /ping -- health check with latency",
        "  /reset -- clear session and start fresh",
        "  /restart -- restart the bot process",
        "  /plugins -- list loaded plugins",
        "  /help -- this message",
        "",
        "<b>Input</b>",
        "  Text, photos, documents, voice notes, audio, videos, GIFs, stickers, video notes, forwarded messages, reply context",
        "",
        "<b>Messaging</b>",
        "  Send, reply, edit, delete, forward, copy, pin/unpin messages. Inline keyboards with callback buttons. Scheduled messages.",
        "",
        "<b>Media</b>",
        "  Send photos, videos, GIFs, voice notes, stickers, files, polls, locations, contacts, dice.",
        "",
        "<b>Chat</b>",
        "  Read history, search messages, list members, get chat info, manage titles and descriptions.",
        "",
        "<b>Web</b>",
        "  Ask Talon to read a URL — it can fetch and summarize web pages.",
        "",
        "<b>Groups</b>",
        "  Mention @" +
          escapeHtml(ctx.me.username ?? "bot") +
          " or reply to activate.",
        "",
        "<b>Files</b>",
        "  Ask me to create a file and I'll send it as an attachment.",
      ].join("\n"),
      { parse_mode: "HTML" },
    ),
  );

  bot.command("reset", async (ctx) => {
    const cid = String(ctx.chat.id);
    const info = getSessionInfo(cid);

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

    resetSession(cid);
    clearHistory(cid);
    resetPulseCheckpoint(cid);
    // Resolve the per-chat backend so the reset+warm hits the correct
    // provider when this chat has a backend override pinned.
    const chatBackend = resolveBackendForChat(cid, gateway);
    // Wipe any in-process backend memory (e.g. openai-agents'
    // MemorySession). Stateless backends ignore this.
    chatBackend?.sessions?.resetChat?.(cid);
    // Warm up the new session so /status has context data immediately.
    await chatBackend?.sessions?.warmSession?.(cid);
    await ctx.reply("Session cleared.");
  });

  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const sent = await ctx.reply("...");
    const latency = Date.now() - start;

    const bridgeOk = true;
    const userbotOk = isUserClientReady();
    const uptime = formatDuration(process.uptime() * 1000);

    const statusLine = [
      `Bridge: ${bridgeOk ? "\u2713" : "\u2717"}`,
      `Userbot: ${userbotOk ? "\u2713" : "\u2717"}`,
      `Uptime: ${uptime}`,
    ].join(" | ");

    try {
      await bot.api.editMessageText(
        ctx.chat.id,
        sent.message_id,
        `Pong! ${latency}ms\n${statusLine}`,
      );
    } catch {
      // ignore edit failure
    }
  });

  bot.command("model", async (ctx) => {
    const cid = String(ctx.chat.id);
    const arg = ctx.match?.trim();
    // Resolve through the active-backend-aware helper. Returns null
    // when the catalog-driven backend has no per-chat pick AND no
    // operator default — UI surfaces that as "No model selected".
    const be = resolveBackendForChat(cid, gateway);
    const beId = getBackendIdForChat(cid);
    const { model: resolvedActive } = await resolveActiveModelForChat(
      cid,
      be,
      beId,
      config,
    );
    const activeModel = resolvedActive ?? "No model selected";

    if (
      !arg ||
      arg.toLowerCase() === "reset" ||
      arg.toLowerCase() === "default"
    ) {
      if (arg) {
        // Clear THIS backend's slot only — other backends' picks stay.
        setChatModelForBackend(cid, beId, undefined);
        const { model: postResetModel } = await resolveActiveModelForChat(
          cid,
          be,
          beId,
          config,
        );
        const body = postResetModel
          ? `Model reset to default: <code>${escapeHtml(postResetModel)}</code>`
          : `Model reset — no default available for backend <code>${escapeHtml(beId)}</code>. Use /model to pick one.`;
        await ctx.reply(body, { parse_mode: "HTML" });
        return;
      }
      // Render the main /model menu. Browsing the catalog happens
      // behind the "Browse models" button — see callbacks.ts. The
      // controller resolves the per-chat backend so the menu reflects
      // any active per-chat override (e.g. a chat switched to
      // openai-agents in a Claude-default install).
      const view = await buildModelMenuViewForChat(cid, config, gateway);
      if (view) {
        await ctx.reply(renderModelMenuText(view.state), {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: renderModelMenuKeyboard(view.state),
          },
        });
      } else {
        await ctx.reply(
          `<b>Model:</b> <code>${escapeHtml(formatModelLabel(activeModel))}</code>`,
          {
            parse_mode: "HTML",
          },
        );
      }
      return;
    }

    // `be` + `beId` already resolved above for the activeModel lookup.
    // Reuse them — they point at the per-chat backend (override-aware).
    if (be?.models?.resolveModelInfo) {
      const resolution = await be.models?.resolveModelInfo(arg);
      if (resolution.kind !== "exact") {
        const msg =
          be.models?.formatModelError?.(arg, resolution) ??
          `No model matched "${escapeHtml(arg)}".`;
        await ctx.reply(msg, { parse_mode: "HTML" });
        return;
      }
      if (!resolution.model.selectable) {
        const msg =
          resolution.model.unavailableReason ??
          `${resolution.model.providerName} is not connected.`;
        await ctx.reply(escapeHtml(msg), { parse_mode: "HTML" });
        return;
      }
      setChatModelForBackend(cid, beId, resolution.storedValue);
      setChatBackend(cid, beId);
      await ctx.reply(
        `Model set to <code>${escapeHtml(resolution.storedValue)}</code> (${escapeHtml(resolution.model.providerName)}${resolution.model.free ? " \u00B7 free" : ""}).`,
        { parse_mode: "HTML" },
      );
    } else {
      // Fallback for backends without model resolution
      const model = resolveModelName(arg);
      setChatModelForBackend(cid, beId, model);
      setChatBackend(cid, beId);
      await ctx.reply(
        `Model set to <code>${escapeHtml(formatModelLabel(model))}</code>.`,
        { parse_mode: "HTML" },
      );
    }
  });

  bot.command("effort", async (ctx) => {
    const cid = String(ctx.chat.id);
    const arg = ctx.match?.trim().toLowerCase();
    const settings = getChatSettings(cid);
    const be = resolveBackendForChat(cid, gateway);
    const beId = getBackendIdForChat(cid);
    const reasoning = await getActiveReasoningLevels({
      chatId: cid,
      backend: be,
      backendId: beId,
      config,
    });

    if (reasoning.levels.length === 0) {
      const modelText = reasoning.activeModel
        ? `<code>${escapeHtml(formatModelLabel(reasoning.activeModel))}</code>`
        : "the active model";
      await ctx.reply(
        `No valid reasoning levels found for ${modelText} on backend <code>${escapeHtml(beId)}</code>.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (!arg) {
      const current = displayReasoningEffort(settings.effort, reasoning.levels);
      await ctx.reply(`<b>Effort:</b> ${current}\nSelect a level:`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: renderEffortRows(
            current,
            reasoning.levels,
            "effort:",
          ),
        },
      });
      return;
    }

    if (arg === "reset" || arg === "default" || arg === "adaptive") {
      setChatEffort(cid, undefined);
      await ctx.reply(
        "Effort reset to <b>adaptive</b> (model decides when to think)",
        { parse_mode: "HTML" },
      );
      return;
    }

    if (supportsReasoningLevel(arg, reasoning.levels)) {
      setChatEffort(cid, arg as EffortLevel);
      await ctx.reply(`Effort set to <b>${arg}</b>`, { parse_mode: "HTML" });
      return;
    }

    await ctx.reply(
      `Unknown level for this model. Valid: ${reasoning.levels.join(", ")}, or adaptive.`,
    );
  });

  bot.command("pulse", async (ctx) => {
    const cid = String(ctx.chat.id);
    const arg = ctx.match?.trim().toLowerCase();

    if (!arg || arg === "status") {
      const enabled = isPulseEnabled(cid);
      await ctx.reply(
        [
          `<b>🔔 Pulse:</b> ${enabled ? "on" : "off"}`,
          "",
          "Reads along every few minutes and jumps in when there's something to add.",
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: enabled ? "✓ On" : "On", callback_data: "pulse:on" },
                {
                  text: !enabled ? "✓ Off" : "Off",
                  callback_data: "pulse:off",
                },
              ],
            ],
          },
        },
      );
      return;
    }

    if (arg === "on" || arg === "enable") {
      enablePulse(cid);
      registerChat(cid);
      await ctx.reply("🔔 Pulse enabled.");
      return;
    }

    if (arg === "off" || arg === "disable") {
      disablePulse(cid);
      await ctx.reply("🔔 Pulse disabled.");
      return;
    }

    const intervalMs = parseInterval(arg);
    if (intervalMs && intervalMs >= 5 * 60 * 1000) {
      setChatPulseInterval(cid, intervalMs);
      enablePulse(cid);
      registerChat(cid);
      await ctx.reply(
        `🔔 Pulse cooldown set to <b>${formatDuration(intervalMs)}</b>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (intervalMs) {
      await ctx.reply("Minimum interval is 5 minutes.");
      return;
    }

    await ctx.reply("Use: /pulse on, /pulse off, /pulse 30m, /pulse 2h");
  });

  bot.command("memory", async (ctx) => {
    try {
      const memoryPath = files.memory;
      if (!existsSync(memoryPath)) {
        await ctx.reply(
          "No memory file yet. I'll create one as I learn about you.",
        );
        return;
      }
      const content = readFileSync(memoryPath, "utf-8").trim();
      if (!content) {
        await ctx.reply("Memory file is empty. I'll update it as we chat.");
        return;
      }
      // Truncate for Telegram's 4096 char limit
      const display =
        content.length > 3500
          ? content.slice(0, 3500) + "\n\n... (truncated)"
          : content;
      await ctx.reply(display);
    } catch {
      await ctx.reply("Could not read memory file.");
    }
  });

  bot.command("settings", async (ctx) => {
    const cid = String(ctx.chat.id);
    const chatSets = getChatSettings(cid);
    const settingsBe = resolveBackendForChat(cid, gateway);
    const settingsBeId = getBackendIdForChat(cid);
    const { model: resolvedSettingsModel } = await resolveActiveModelForChat(
      cid,
      settingsBe,
      settingsBeId,
      config,
    );
    const activeModel = resolvedSettingsModel ?? "No model selected";
    const reasoning = await getActiveReasoningLevels({
      chatId: cid,
      backend: settingsBe,
      backendId: settingsBeId,
      config,
    });
    const effortName = displayReasoningEffort(
      chatSets.effort,
      reasoning.levels,
    );
    const pulseOn = isPulseEnabled(cid);
    let modelButtons: Array<SettingsButton> | undefined;
    let pager:
      | {
          page: number;
          totalPages: number;
          filter: "all" | "free";
          freeCount: number;
          totalCount: number;
          provider?: string;
        }
      | undefined;
    let view: "models" | "groups" = "models";
    let activeProvider: string | undefined;
    if (settingsBe?.models?.getSettingsPresentation && resolvedSettingsModel) {
      const pres = await settingsBe.models?.getSettingsPresentation(
        resolvedSettingsModel,
      );
      modelButtons = pres.modelButtons;
      pager = {
        page: pres.page,
        totalPages: pres.totalPages,
        filter: pres.filter,
        freeCount: pres.freeCount,
        totalCount: pres.totalCount,
        provider: pres.provider,
      };
      view = pres.view;
      activeProvider = pres.provider;
    }

    await ctx.reply(
      renderSettingsText(
        activeModel,
        effortName,
        pulseOn,
        chatSets.pulseIntervalMs,
      ),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: renderSettingsKeyboard(
            activeModel,
            effortName,
            pulseOn,
            modelButtons,
            pager,
            view,
            activeProvider,
            reasoning.levels,
          ),
        },
      },
    );
  });

  bot.command("admin", async (ctx) => {
    if (ADMIN_USER_ID !== 0 && ctx.from?.id !== ADMIN_USER_ID) {
      await ctx.reply("Not authorized.");
      return;
    }
    await handleAdminCommand(ctx, bot, config);
  });

  bot.command("status", async (ctx) => {
    const cid = String(ctx.chat.id);
    const info = getSessionInfo(cid);
    const u = info.usage;
    const uptime = formatDuration(process.uptime() * 1000);
    const sessionAge = info.createdAt
      ? formatDuration(Date.now() - info.createdAt)
      : "\u2014";
    const chatSets = getChatSettings(cid);
    const statusBe = resolveBackendForChat(cid, gateway);
    const statusBeId = getBackendIdForChat(cid);
    // Consume the resolved `ModelRef` so context window, cache
    // support, and display name come from one enriched object
    // instead of three separate fetches. The ref resolver wraps the
    // same 5-step chain as `resolveActiveModelForChat`, so the active
    // model id is identical; the difference is one fewer round-trip
    // to `getRawModelInfo` for the common case.
    const { ref: statusModelRef } = await resolveActiveModelForChat(
      cid,
      statusBe,
      statusBeId,
      config,
    );
    const activeModel = statusModelRef?.id ?? "No model selected";
    const effortName = chatSets.effort ?? "adaptive";
    const pulseOn = isPulseEnabled(cid);

    let ctxMax = u.contextWindow; // from SDK modelUsage, preserved across turns
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
        // Re-fetch context window for the actual model if different
        if (
          snap.contextModelId &&
          snap.contextModelId !== activeModel &&
          be.models?.getRawModelInfo
        ) {
          const ctxModelInfo = await be.models
            ?.getRawModelInfo(snap.contextModelId)
            .catch(() => undefined);
          if (ctxModelInfo?.contextWindow) ctxMax = ctxModelInfo.contextWindow;
        }
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
    const contextWarn = context.warn ? " \u26A0\uFE0F consider /reset" : "";
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
      `<b>\uD83E\uDD85 Talon</b> \u00B7 <code>${escapeHtml(formatModelLabel(activeModel))}</code>${backendLabel ? ` \u00B7 <i>${escapeHtml(backendLabel)}</i>` : ""} \u00B7 effort: ${effortName}`,
      "",
      `<b>Context</b>  ${contextUsedText} / ${contextMaxText} (${context.known ? `${context.pct}%` : "unknown"})${contextWarn}`,
      `<code>${context.bar}</code>`,
      "",
      `<b>Session Stats</b>`,
      `  Response  last ${lastResponseMs ? formatDuration(lastResponseMs) : "\u2014"} \u00B7 avg ${avgResponseMs ? formatDuration(avgResponseMs) : "\u2014"} \u00B7 best ${fastestMs ? formatDuration(fastestMs) : "\u2014"}`,
      `  Turns     ${info.turns}${turnsModelLabel ? ` (${formatModelLabel(turnsModelLabel)})` : ""}`,
      "",
      ...(cache
        ? [
            `<b>Cache</b>     ${cache.hitPct}% hit`,
            `  Read ${formatTokenCount(cache.read)}${cache.showsWrite ? `  Write ${formatTokenCount(cache.write)}` : ""}`,
          ]
        : []),
      `  Input ${formatTokenCount(displayInputTokens)}  Output ${formatTokenCount(displayOutputTokens)}`,
      "",
      `<b>Pulse</b>  ${pulseOn ? "on" : "off"}`,
      `<b>Workspace</b>  ${diskStr}`,
      `<b>Session</b>   ${info.sessionName ? `"${escapeHtml(info.sessionName)}" ` : ""}${info.sessionId ? "<code>" + escapeHtml(info.sessionId.slice(0, 8)) + "...</code>" : "<i>(new)</i>"} \u00B7 ${sessionAge} old`,
      `<b>Uptime</b>    ${uptime} \u00B7 ${getActiveSessionCount()} active session${getActiveSessionCount() === 1 ? "" : "s"}`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("metrics", async (ctx) => {
    if (ADMIN_USER_ID && ctx.from?.id !== ADMIN_USER_ID) {
      await ctx.reply("Not authorized.");
      return;
    }
    for (const message of renderMetricsMessages(getMetrics())) {
      await ctx.reply(message, { parse_mode: "HTML" });
    }
  });

  bot.command("doctor", async (ctx) => {
    if (ADMIN_USER_ID && ctx.from?.id !== ADMIN_USER_ID) {
      await ctx.reply("Not authorized.");
      return;
    }
    const sent = await ctx.reply("🩺 Running checks...");
    try {
      // Same checks as `talon doctor` — config exists by definition
      // when the bot is processing this command.
      const report = await collectDoctorReport({ config, hasConfigFile: true });
      await bot.api.editMessageText(
        ctx.chat.id,
        sent.message_id,
        renderDoctorMessage(report),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await bot.api.editMessageText(
        ctx.chat.id,
        sent.message_id,
        `🩺 Doctor failed: ${escapeHtml(msg)}`,
        { parse_mode: "HTML" },
      );
    }
  });

  bot.command("dream", async (ctx) => {
    if (ADMIN_USER_ID && ctx.from?.id !== ADMIN_USER_ID) {
      await ctx.reply("Not authorized.");
      return;
    }
    const sent = await ctx.reply("🌙 Dream mode starting...");
    const start = Date.now();
    // Fire-and-forget — don't await, so grammY can keep processing other updates
    forceDream()
      .then(async () => {
        const elapsed = formatDuration(Date.now() - start);
        await bot.api.editMessageText(
          ctx.chat.id,
          sent.message_id,
          `🌙 Dream complete — memory consolidated in ${elapsed}.`,
        );
      })
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        await bot.api.editMessageText(
          ctx.chat.id,
          sent.message_id,
          `🌙 Dream failed: ${escapeHtml(msg)}`,
          { parse_mode: "HTML" },
        );
      });
  });

  bot.command("restart", async (ctx) => {
    if (ADMIN_USER_ID && ctx.from?.id !== ADMIN_USER_ID) {
      await ctx.reply("Not authorized.");
      return;
    }
    await ctx.reply("♻️ Restarting...");
    respawnSelf("telegram /restart");
  });

  bot.command("plugins", async (ctx) => {
    const plugins = getLoadedPlugins();
    if (plugins.length === 0) {
      await ctx.reply("No plugins loaded.");
      return;
    }
    const lines = plugins.map((p) => {
      const ver = p.plugin.version ? ` v${p.plugin.version}` : "";
      const desc = p.plugin.description ? ` — ${p.plugin.description}` : "";
      const mcp = p.plugin.mcpServerPath ? " [MCP]" : "";
      const fe = p.plugin.frontends?.length
        ? ` (${p.plugin.frontends.join(", ")})`
        : "";
      return `• <b>${escapeHtml(p.plugin.name)}</b>${ver}${mcp}${fe}${desc}`;
    });
    await ctx.reply(
      `<b>Plugins (${plugins.length})</b>\n\n${lines.join("\n")}`,
      { parse_mode: "HTML" },
    );
  });

  // Unknown /command → "did you mean ...?" via the C similarity core
  // (native/strsim-c). Registered after every real command, so grammY
  // only reaches this when nothing above matched. Only bare commands
  // are intercepted — a close miss gets a suggestion, anything else
  // keeps flowing to the agent as a normal message.
  const commandNames = TELEGRAM_COMMANDS.map((c) => c.command);
  bot.on("message::bot_command", async (ctx, next) => {
    const typed = /^\/([a-zA-Z0-9_]+)(?:@(\w+))?\s*$/.exec(ctx.msg.text ?? "");
    if (!typed) return next();
    const [, name, mention] = typed;
    // In groups a command can be addressed to another bot — not ours
    // to answer.
    if (mention && mention.toLowerCase() !== ctx.me.username.toLowerCase()) {
      return next();
    }
    const suggestion = closestMatch(name.toLowerCase(), commandNames);
    if (!suggestion) return next();
    await ctx.reply(
      `Unknown command /${name} — did you mean /${suggestion.value}?`,
    );
  });
}
