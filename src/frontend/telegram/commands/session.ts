/**
 * Session commands — /reset and /status.
 */

import type { Bot } from "grammy";
import {
  resetSession,
  getSessionInfo,
  getActiveSessionCount,
} from "../../../storage/sessions.js";
import { clearHistory } from "../../../storage/history.js";
import { getChatSettings } from "../../../storage/chat-settings.js";
import {
  isPulseEnabled,
  resetPulseCheckpoint,
} from "../../../core/background/pulse.js";
import { getWorkspaceDiskUsage } from "../../../util/workspace.js";
import { appendDailyLog } from "../../../storage/daily-log.js";
import { escapeHtml } from "../formatting.js";
import {
  formatModelLabel,
  formatDuration,
  formatTokenCount,
  formatBytes,
} from "../helpers/index.js";
import { resolveBackendForChat } from "../model-menu.js";
import { getBackendIdForChat } from "../../../core/engine/backend-controller/index.js";
import { resolveActiveModelForChat } from "../../../core/models/active-model.js";
import {
  buildCacheDisplay,
  buildContextDisplay,
} from "../../shared/status-context.js";
import type { RegisterDeps } from "./state.js";

export function registerSessionCommands(
  bot: Bot,
  { config, gateway }: RegisterDeps,
): void {
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

  bot.command("status", async (ctx) => {
    const cid = String(ctx.chat.id);
    const info = getSessionInfo(cid);
    const u = info.usage;
    const uptime = formatDuration(process.uptime() * 1000);
    const sessionAge = info.createdAt
      ? formatDuration(Date.now() - info.createdAt)
      : "—";
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
      `<b>🦅 Talon</b> · <code>${escapeHtml(formatModelLabel(activeModel))}</code>${backendLabel ? ` · <i>${escapeHtml(backendLabel)}</i>` : ""} · effort: ${effortName}${info.turnInProgress ? " · ⏳ turn running" : ""}`,
      "",
      `<b>Context</b>  ${contextUsedText} / ${contextMaxText} (${context.known ? `${context.pct}%` : "unknown"})${contextWarn}`,
      `<code>${context.bar}</code>`,
      "",
      `<b>Session Stats</b>`,
      `  Response  last ${lastResponseMs ? formatDuration(lastResponseMs) : "—"} · avg ${avgResponseMs ? formatDuration(avgResponseMs) : "—"} · best ${fastestMs ? formatDuration(fastestMs) : "—"}`,
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
      `<b>Session</b>   ${info.sessionName ? `"${escapeHtml(info.sessionName)}" ` : ""}${info.sessionId ? "<code>" + escapeHtml(info.sessionId.slice(0, 8)) + "...</code>" : "<i>(new)</i>"} · ${sessionAge} old`,
      `<b>Uptime</b>    ${uptime} · ${getActiveSessionCount()} active session${getActiveSessionCount() === 1 ? "" : "s"}`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });
}
