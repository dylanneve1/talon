/**
 * Session commands — /reset and /status.
 *
 * Data gathering and the reset sequence live in
 * frontend/shared/session-status.ts; this file only renders Telegram HTML.
 */

import type { Bot } from "grammy";
import { escapeHtml } from "../formatting.js";
import {
  formatModelLabel,
  formatDuration,
  formatTokenCount,
  formatBytes,
} from "../helpers/index.js";
import { resolveBackendForChat } from "../model-menu.js";
import { getBackendIdForChat } from "../../../core/engine/backend-controller/index.js";
import {
  performSessionReset,
  collectSessionStatus,
} from "../../shared/session-status.js";
import type { RegisterDeps } from "./state.js";

export function registerSessionCommands(
  bot: Bot,
  { config, gateway }: RegisterDeps,
): void {
  bot.command("reset", async (ctx) => {
    const cid = String(ctx.chat.id);
    // Resolve the per-chat backend so the reset+warm hits the correct
    // provider when this chat has a backend override pinned.
    await performSessionReset(cid, resolveBackendForChat(cid, gateway));
    await ctx.reply("Session cleared.");
  });

  bot.command("status", async (ctx) => {
    const cid = String(ctx.chat.id);
    const s = await collectSessionStatus(
      cid,
      config,
      resolveBackendForChat(cid, gateway),
      getBackendIdForChat(cid),
    );

    const contextWarn = s.context.warn ? " ⚠️ consider /reset" : "";
    const contextUsedText = s.context.known
      ? formatTokenCount(s.context.used)
      : "unknown";
    const contextMaxText =
      s.context.max > 0 ? formatTokenCount(s.context.max) : "unknown";

    const lines = [
      `<b>🦅 Talon</b> · <code>${escapeHtml(formatModelLabel(s.activeModel))}</code>${s.backendLabel ? ` · <i>${escapeHtml(s.backendLabel)}</i>` : ""} · effort: ${s.effortName}${s.turnInProgress ? " · ⏳ turn running" : ""}`,
      "",
      `<b>Context</b>  ${contextUsedText} / ${contextMaxText} (${s.context.known ? `${s.context.pct}%` : "unknown"})${contextWarn}`,
      `<code>${s.context.bar}</code>`,
      "",
      `<b>Session Stats</b>`,
      `  Response  last ${s.lastResponseMs ? formatDuration(s.lastResponseMs) : "—"} · avg ${s.avgResponseMs ? formatDuration(s.avgResponseMs) : "—"} · best ${s.fastestMs ? formatDuration(s.fastestMs) : "—"}`,
      `  Turns     ${s.turns}${s.turnsModelLabel ? ` (${formatModelLabel(s.turnsModelLabel)})` : ""}`,
      "",
      ...(s.cache
        ? [
            `<b>Cache</b>     ${s.cache.hitPct}% hit`,
            `  Read ${formatTokenCount(s.cache.read)}${s.cache.showsWrite ? `  Write ${formatTokenCount(s.cache.write)}` : ""}`,
          ]
        : []),
      `  Input ${formatTokenCount(s.inputTokens)}  Output ${formatTokenCount(s.outputTokens)}`,
      "",
      `<b>Pulse</b>  ${s.pulseOn ? "on" : "off"}`,
      `<b>Workspace</b>  ${formatBytes(s.diskBytes)}`,
      `<b>Session</b>   ${s.sessionName ? `"${escapeHtml(s.sessionName)}" ` : ""}${s.sessionId ? "<code>" + escapeHtml(s.sessionId.slice(0, 8)) + "...</code>" : "<i>(new)</i>"} · ${s.sessionAge} old`,
      `<b>Uptime</b>    ${s.uptime} · ${s.activeSessionCount} active session${s.activeSessionCount === 1 ? "" : "s"}`,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });
}
