/**
 * Session commands — /reset and /status.
 */

import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import type { TalonConfig } from "../../../util/config.js";
import type { Gateway } from "../../../core/engine/gateway.js";
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
import {
  formatModelLabel,
  formatDuration,
  formatTokenCount,
  formatBytes,
} from "../helpers.js";
import {
  buildCacheDisplay,
  buildContextDisplay,
} from "../../shared/status-context.js";
import {
  getBackendIdForChat,
  resolveChatBackend,
} from "../../../core/engine/backend-controller/index.js";
import { resolveActiveModelForChat } from "../../../core/models/active-model.js";
import { reply } from "./shared.js";

export async function handleReset(
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

export async function handleStatus(
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
