/**
 * Daily log system — appends brief interaction summaries to workspace/logs/YYYY-MM-DD.md.
 * Claude can reference these via the Read tool for continuity across sessions.
 */

import { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { log as logInfo, logError } from "../util/log.js";
import { dirs } from "../util/paths.js";

const LOGS_DIR = dirs.logs;
const MAX_LOG_DAYS = 30; // Keep last 30 days of logs

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Append a user message entry to today's daily log.
 * Format: ## HH:MM -- [chatTitle/userName]\nmessage text\n
 * @param chatName - Display name of the sender (or "System")
 * @param text - Message content
 * @param chatContext - Optional chat context (group title, username, etc.)
 */
export function appendDailyLog(chatName: string, text: string, chatContext?: { chatTitle?: string; username?: string }): void {
  try {
    ensureLogsDir();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = now.toTimeString().slice(0, 5); // HH:MM
    const logFile = resolve(LOGS_DIR, `${dateStr}.md`);

    const label = formatLabel(chatName, chatContext);
    const entry = `## ${timeStr} -- [${label}]\n${text}\n\n`;
    appendFileSync(logFile, entry);
  } catch (err) {
    logError("bot", "Daily log write failed", err);
  }
}

/**
 * Append a bot response entry to today's daily log.
 * Format: ## HH:MM -- [botName] in chatTitle\nresponse text\n
 */
export function appendDailyLogResponse(botName: string, text: string, chatContext?: { chatTitle?: string }): void {
  try {
    ensureLogsDir();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = now.toTimeString().slice(0, 5); // HH:MM
    const logFile = resolve(LOGS_DIR, `${dateStr}.md`);

    const label = chatContext?.chatTitle ? `${botName} in ${chatContext.chatTitle}` : botName;
    const entry = `## ${timeStr} -- [${label}]\n${text}\n\n`;
    appendFileSync(logFile, entry);
  } catch (err) {
    logError("bot", "Daily log response write failed", err);
  }
}

/** Format a log label with optional chat title and username. */
function formatLabel(name: string, ctx?: { chatTitle?: string; username?: string }): string {
  const userPart = ctx?.username ? `${name} (@${ctx.username})` : name;
  if (ctx?.chatTitle) return `${userPart} in ${ctx.chatTitle}`;
  return userPart;
}

/** Get the path to the logs directory (for system prompt reference). */
export function getLogsDir(): string {
  return LOGS_DIR;
}

/** Remove daily logs older than MAX_LOG_DAYS. Called on startup. */
export function cleanupOldLogs(): void {
  try {
    if (!existsSync(LOGS_DIR)) return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_LOG_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let deleted = 0;
    for (const file of readdirSync(LOGS_DIR)) {
      // Log files are named YYYY-MM-DD.md
      if (file.endsWith(".md") && file < cutoffStr) {
        try {
          unlinkSync(resolve(LOGS_DIR, file));
          deleted++;
        } catch { /* skip */ }
      }
    }
    if (deleted > 0) {
      logInfo("workspace", `Cleaned up ${deleted} old daily log(s)`);
    }
  } catch { /* skip */ }
}
