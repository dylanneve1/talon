/**
 * Session commands — /reset and /status.
 *
 * Data gathering and the reset sequence live in
 * frontend/shared/session-status.ts; this file only renders Discord markdown.
 */

import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import type { TalonConfig } from "../../../util/config.js";
import type { Gateway } from "../../../core/engine/gateway.js";
import {
  formatModelLabel,
  formatDuration,
  formatTokenCount,
  formatBytes,
  formatUsd,
} from "../helpers.js";
import {
  getBackendIdForChat,
  resolveChatBackend,
} from "../../../core/engine/backend-controller/index.js";
import {
  performSessionReset,
  collectSessionStatus,
} from "../../shared/session-status.js";
import { reply } from "./shared.js";

export async function handleReset(
  i: ChatInputCommandInteraction,
  gateway: Gateway,
  chatId: string,
): Promise<void> {
  // Defer immediately — warmSession can hit a cold backend (cold container,
  // model load) and miss the 3s interaction ACK window.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  // Must be the actual chat backend, not the global default, when this
  // chat has an override pinned.
  await performSessionReset(
    chatId,
    resolveChatBackend(chatId, gateway?.backend),
  );
  await reply(i, "Session cleared.", true);
}

export async function handleStatus(
  i: ChatInputCommandInteraction,
  config: TalonConfig,
  gateway: Gateway,
  chatId: string,
): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const s = await collectSessionStatus(
    chatId,
    config,
    resolveChatBackend(chatId, gateway?.backend),
    getBackendIdForChat(chatId),
  );

  const contextWarn = s.context.warn ? " ⚠️ consider /reset" : "";
  const contextUsedText = s.context.known
    ? formatTokenCount(s.context.used)
    : "unknown";
  const contextMaxText =
    s.context.max > 0 ? formatTokenCount(s.context.max) : "unknown";

  const lines = [
    `**🦅 Talon** · \`${formatModelLabel(s.activeModel)}\`${s.backendLabel ? ` · *${s.backendLabel}*` : ""} · effort: ${s.effortName}${s.turnInProgress ? " · ⏳ turn running" : ""}`,
    "",
    `**Context** ${contextUsedText} / ${contextMaxText} (${s.context.known ? `${s.context.pct}%` : "unknown"})${contextWarn}`,
    `\`${s.context.bar}\``,
    "",
    "**Session Stats**",
    `  Response  last ${s.lastResponseMs ? formatDuration(s.lastResponseMs) : "—"} · avg ${s.avgResponseMs ? formatDuration(s.avgResponseMs) : "—"} · best ${s.fastestMs ? formatDuration(s.fastestMs) : "—"}`,
    `  Turns     ${s.turns}${s.turnsModelLabel ? ` (${formatModelLabel(s.turnsModelLabel)})` : ""}`,
    "",
    ...(s.cache
      ? [
          `**Cache**     ${s.cache.hitPct}% hit`,
          `  Read ${formatTokenCount(s.cache.read)}${s.cache.showsWrite ? `  Write ${formatTokenCount(s.cache.write)}` : ""}`,
        ]
      : []),
    `  Input ${formatTokenCount(s.inputTokens)}  Output ${formatTokenCount(s.outputTokens)}${s.costUsd > 0 ? `  Cost ${formatUsd(s.costUsd)}` : ""}`,
    "",
    ...(s.plan
      ? [
          `**Plan**${s.plan.plan ? `  ${s.plan.plan}` : ""}${s.plan.ageLabel ? ` *(${s.plan.ageLabel})*` : ""}`,
          ...s.plan.windows.map(
            (w) =>
              `  \`${w.label.padEnd(6)}${w.bar} ${String(w.percent).padStart(3)}%\`${w.resetLabel ? ` reset ${w.resetLabel}` : ""}`,
          ),
          "",
        ]
      : []),
    `**Pulse**  ${s.pulseOn ? "on" : "off"}`,
    `**Workspace**  ${formatBytes(s.diskBytes)}`,
    `**Session**   ${s.sessionName ? `"${s.sessionName}" ` : ""}${s.sessionId ? "`" + s.sessionId.slice(0, 8) + "...`" : "_(new)_"} · ${s.sessionAge} old`,
    `**Uptime**    ${s.uptime} · ${s.activeSessionCount} active session${s.activeSessionCount === 1 ? "" : "s"}`,
  ];
  await i.editReply(lines.join("\n"));
}
