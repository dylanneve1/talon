/**
 * Shared command UI rendering — used by BOTH bot and userbot frontends.
 *
 * All text generation for /status, /settings, /help, /memory, /plugins, /ping
 * lives here. Frontends only handle delivery (Grammy ctx.reply vs GramJS sendMessage).
 *
 * Format parameter controls output:
 *   "html"     → <b>bold</b> <code>mono</code> <i>italic</i>  (Bot API / Grammy)
 *   "markdown" → **bold** `mono` _italic_                      (GramJS / userbot)
 */

import {
  getSessionInfo,
  getActiveSessionCount,
  getAllSessions,
  resetSession as resetSessionFn,
} from "../../storage/sessions.js";
import { clearHistory as clearHistoryFn } from "../../storage/history.js";
import { getHealthStatus, getRecentErrors } from "../../util/watchdog.js";
import { getActiveCount } from "../../core/dispatcher.js";
import {
  getChatSettings,
  resolveModelName,
  setChatModel,
  setChatEffort,
  type EffortLevel,
  EFFORT_LEVELS,
} from "../../storage/chat-settings.js";
import {
  isPulseEnabled,
  enablePulse,
  disablePulse,
  resetPulseCheckpoint,
} from "../../core/pulse.js";
import { getLoadedPlugins } from "../../core/plugin.js";
import { getWorkspaceDiskUsage } from "../../util/workspace.js";
import { files as talonFiles, dirs as talonDirs } from "../../util/paths.js";
import { existsSync, readFileSync } from "node:fs";
import {
  formatDuration,
  formatTokenCount,
  formatBytes,
} from "./helpers.js";

// ── Format helpers ──────────────────────────────────────────────────────────

type Fmt = "html" | "markdown";

function bold(text: string, fmt: Fmt): string {
  return fmt === "html" ? `<b>${text}</b>` : `**${text}**`;
}

function code(text: string, fmt: Fmt): string {
  return fmt === "html" ? `<code>${text}</code>` : `\`${text}\``;
}

function italic(text: string, fmt: Fmt): string {
  return fmt === "html" ? `<i>${text}</i>` : `_${text}_`;
}

function esc(text: string, fmt: Fmt): string {
  if (fmt === "html") return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text;
}

// ── Status ──────────────────────────────────────────────────────────────────

export function renderStatus(chatId: string, defaultModel: string, fmt: Fmt): string {
  const info = getSessionInfo(chatId);
  const u = info.usage;
  const uptime = formatDuration(process.uptime() * 1000);
  const sessionAge = info.createdAt ? formatDuration(Date.now() - info.createdAt) : "—";
  const chatSets = getChatSettings(chatId);
  const activeModel = chatSets.model ?? defaultModel;
  const effortName = chatSets.effort ?? "adaptive";
  const pulseOn = isPulseEnabled(chatId);

  // Context bar
  const contextMax = activeModel.includes("haiku") ? 200_000 : 1_000_000;
  const contextUsed = u.lastPromptTokens;
  const contextPct = contextMax > 0 ? Math.min(100, Math.round((contextUsed / contextMax) * 100)) : 0;
  const barLen = 20;
  const filled = Math.round((contextPct / 100) * barLen);
  const contextBar = "█".repeat(filled) + "░".repeat(barLen - filled);
  const contextWarn = contextPct >= 80 ? " ⚠️ consider /reset" : "";

  // Tokens
  const totalPrompt = u.totalInputTokens + u.totalCacheRead + u.totalCacheWrite;
  const cacheHitPct = totalPrompt > 0 ? Math.round((u.totalCacheRead / totalPrompt) * 100) : 0;

  // Response times
  const avgMs = info.turns > 0 && u.totalResponseMs ? Math.round(u.totalResponseMs / info.turns) : 0;
  const lastMs = u.lastResponseMs || 0;
  const fastestMs = u.fastestResponseMs === Infinity ? 0 : (u.fastestResponseMs || 0);

  // Workspace
  let diskStr = "—";
  try { diskStr = formatBytes(getWorkspaceDiskUsage(talonDirs.workspace)); } catch { /* */ }

  return [
    `${bold("🦅 Talon", fmt)} · ${code(esc(activeModel, fmt), fmt)} · effort: ${effortName}`,
    "",
    `${bold("Context", fmt)}  ${formatTokenCount(contextUsed)} / ${formatTokenCount(contextMax)} (${contextPct}%)${contextWarn}`,
    code(contextBar, fmt),
    "",
    bold("Session Stats", fmt),
    `  Response  last ${lastMs ? formatDuration(lastMs) : "—"} · avg ${avgMs ? formatDuration(avgMs) : "—"} · best ${fastestMs ? formatDuration(fastestMs) : "—"}`,
    `  Turns     ${info.turns}${info.lastModel ? ` (${info.lastModel.replace("claude-", "")})` : ""}`,
    "",
    `${bold("Cache", fmt)}     ${cacheHitPct}% hit`,
    `  Read ${formatTokenCount(u.totalCacheRead)}  Write ${formatTokenCount(u.totalCacheWrite)}`,
    `  Input ${formatTokenCount(u.totalInputTokens)}  Output ${formatTokenCount(u.totalOutputTokens)}`,
    "",
    `${bold("Pulse", fmt)}  ${pulseOn ? "on" : "off"}`,
    `${bold("Workspace", fmt)}  ${diskStr}`,
    `${bold("Session", fmt)}   ${info.sessionName ? `"${esc(info.sessionName, fmt)}" ` : ""}${info.sessionId ? code(info.sessionId.slice(0, 8) + "...", fmt) : italic("(new)", fmt)} · ${sessionAge} old`,
    `${bold("Uptime", fmt)}    ${uptime} · ${getActiveSessionCount()} active session${getActiveSessionCount() === 1 ? "" : "s"}`,
  ].join("\n");
}

// ── Settings ────────────────────────────────────────────────────────────────

export function renderSettings(chatId: string, defaultModel: string, fmt: Fmt): string {
  const chatSets = getChatSettings(chatId);
  const activeModel = chatSets.model ?? defaultModel;
  const effortName = chatSets.effort ?? "adaptive";
  const pulseOn = isPulseEnabled(chatId);
  const intervalMs = chatSets.pulseIntervalMs ?? 300_000;

  return [
    `${bold("⚙️ Settings", fmt)}`,
    "",
    `${bold("Model:", fmt)} ${code(esc(activeModel, fmt), fmt)}`,
    `${bold("Effort:", fmt)} ${effortName}`,
    `${bold("Pulse:", fmt)} ${pulseOn ? "on" : "off"} (every ${formatDuration(intervalMs)})`,
    "",
    `Change: ${code("/model opus", fmt)} · ${code("/effort high", fmt)} · ${code("/pulse on", fmt)}`,
  ].join("\n");
}

// ── Help ────────────────────────────────────────────────────────────────────

export function renderHelp(botUsername: string | undefined, fmt: Fmt): string {
  return [
    `${bold("🦅 Talon — Help", fmt)}`,
    "",
    bold("Settings", fmt),
    "  /settings — view and change all chat settings",
    "  /model — show or change model (sonnet, opus, haiku)",
    "  /effort — set thinking effort (off, low, medium, high, max)",
    "  /pulse — toggle periodic check-ins (on/off)",
    "",
    bold("Session", fmt),
    "  /status — session info, usage, and stats",
    "  /memory — view what Talon remembers",
    "  /dream — force memory consolidation now",
    "  /ping — health check with latency",
    "  /reset — clear session and start fresh",
    "  /restart — restart the process",
    "  /plugins — list loaded plugins",
    "  /help — this message",
    "",
    bold("Input", fmt),
    "  Text, photos, documents, voice notes, audio, videos, GIFs, stickers, video notes, forwarded messages, reply context",
    "",
    bold("Groups", fmt),
    botUsername
      ? `  Mention @${esc(botUsername, fmt)} or reply to activate.`
      : "  @mention or reply to activate.",
    "",
    bold("Files", fmt),
    "  Ask me to create a file and I'll send it as an attachment.",
  ].join("\n");
}

// ── Ping ────────────────────────────────────────────────────────────────────

export function renderPing(latencyMs: number, userbotOk: boolean): string {
  const uptime = formatDuration(process.uptime() * 1000);
  return `Pong! ${latencyMs}ms | Userbot: ${userbotOk ? "✓" : "✗"} | Uptime: ${uptime}`;
}

// ── Memory ──────────────────────────────────────────────────────────────────

export function renderMemory(): string {
  try {
    if (!existsSync(talonFiles.memory)) return "No memory file yet. I'll create one as I learn about you.";
    const content = readFileSync(talonFiles.memory, "utf-8").trim();
    if (!content) return "Memory file is empty. I'll update it as we chat.";
    return content.length > 3500 ? content.slice(0, 3500) + "\n\n... (truncated)" : content;
  } catch {
    return "Could not read memory file.";
  }
}

// ── Plugins ─────────────────────────────────────────────────────────────────

export function renderPlugins(fmt: Fmt): string {
  const plugins = getLoadedPlugins();
  if (plugins.length === 0) return "No plugins loaded.";
  const lines = plugins.map((p) => {
    const ver = p.plugin.version ? ` v${p.plugin.version}` : "";
    const desc = p.plugin.description ? ` — ${p.plugin.description}` : "";
    const mcp = p.plugin.mcpServerPath ? " [MCP]" : "";
    const fe = p.plugin.frontends?.length ? ` (${p.plugin.frontends.join(", ")})` : "";
    return `• ${bold(esc(p.plugin.name, fmt), fmt)}${ver}${mcp}${fe}${desc}`;
  });
  return `${bold(`Plugins (${plugins.length})`, fmt)}\n\n${lines.join("\n")}`;
}

// ── Model command logic ─────────────────────────────────────────────────────

export function handleModelCommand(chatId: string, arg: string | undefined, defaultModel: string, fmt: Fmt): string {
  if (!arg) {
    const current = getChatSettings(chatId).model ?? defaultModel;
    return `${bold("Model:", fmt)} ${code(esc(current, fmt), fmt)}\nChange: ${code("/model sonnet", fmt)}, ${code("/model opus", fmt)}, ${code("/model haiku", fmt)}, ${code("/model reset", fmt)}`;
  }
  if (arg === "reset" || arg === "default") {
    setChatModel(chatId, undefined);
    return `Model reset to default: ${code(esc(defaultModel, fmt), fmt)}`;
  }
  const model = resolveModelName(arg);
  setChatModel(chatId, model);
  return `Model set to ${code(esc(model, fmt), fmt)}.`;
}

// ── Effort command logic ────────────────────────────────────────────────────

export function handleEffortCommand(chatId: string, arg: string | undefined, fmt: Fmt): string {
  if (!arg) {
    const current = getChatSettings(chatId).effort ?? "adaptive";
    return `${bold("Effort:", fmt)} ${current}\nChange: ${code("/effort low", fmt)}, ${code("/effort high", fmt)}, ${code("/effort max", fmt)}`;
  }
  if (arg === "reset" || arg === "default" || arg === "adaptive") {
    setChatEffort(chatId, undefined);
    return `Effort reset to ${bold("adaptive", fmt)} (Claude decides when to think)`;
  }
  if (EFFORT_LEVELS.includes(arg as EffortLevel)) {
    setChatEffort(chatId, arg as EffortLevel);
    return `Effort set to ${bold(arg, fmt)}`;
  }
  return "Unknown level. Use: off, low, medium, high, max, or adaptive.";
}

// ── Pulse command logic ─────────────────────────────────────────────────────

export function handlePulseCommand(chatId: string, arg: string | undefined, fmt: Fmt): string {
  if (!arg) {
    const on = isPulseEnabled(chatId);
    return `${bold("🔔 Pulse:", fmt)} ${on ? "on" : "off"}\nToggle: ${code("/pulse on", fmt)}, ${code("/pulse off", fmt)}`;
  }
  if (arg === "on" || arg === "enable") {
    enablePulse(chatId);
    return "🔔 Pulse enabled.";
  }
  if (arg === "off" || arg === "disable") {
    disablePulse(chatId);
    return "🔔 Pulse disabled.";
  }
  return "Use: /pulse on, /pulse off";
}

// ── Reset logic ─────────────────────────────────────────────────────────────

export function handleReset(chatId: string): string {
  resetSessionFn(chatId);
  clearHistoryFn(chatId);
  resetPulseCheckpoint(chatId);
  return "Session cleared.";
}

// ── Admin ───────────────────────────────────────────────────────────────────

export function renderAdminHealth(fmt: Fmt): string {

  const health = getHealthStatus();
  const errors = getRecentErrors(5).map((e) => typeof e === "string" ? e : String((e as { message?: string }).message ?? e));
  const sessions = (getAllSessions() as unknown[]).length;
  const active = getActiveCount() as number;

  const lines = [
    bold("Admin Panel", fmt),
    "",
    `${bold("Health:", fmt)} ${health.healthy ? "✓ healthy" : "⚠ degraded"}`,
    `${bold("Active dispatches:", fmt)} ${active}`,
    `${bold("Sessions:", fmt)} ${sessions}`,
    `${bold("Uptime:", fmt)} ${formatDuration(process.uptime() * 1000)}`,
    `${bold("Memory:", fmt)} ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
  ];
  if (errors.length > 0) {
    lines.push("", bold("Recent errors:", fmt));
    for (const e of errors) lines.push(`  • ${e}`);
  }
  lines.push("", `Subcommands: ${code("/admin health", fmt)}, ${code("/admin chats", fmt)}`);
  return lines.join("\n");
}

export function renderAdminChats(fmt: Fmt): string {
  const sessions = getAllSessions();
  if (sessions.length === 0) return "No active sessions.";

  sessions.sort((a, b) => (b.info.lastActive || 0) - (a.info.lastActive || 0));
  const lines = sessions.map((s) => {
    const age = s.info.lastActive ? `${Math.round((Date.now() - s.info.lastActive) / 60000)}m ago` : "?";
    return `${code(s.chatId, fmt)} · ${s.info.turns} turns · ${age}`;
  });
  return `${bold(`Active chats (${sessions.length})`, fmt)}\n\n${lines.join("\n")}`;
}
