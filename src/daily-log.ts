/**
 * Daily log system — appends brief interaction summaries to workspace/logs/YYYY-MM-DD.md.
 * Claude can reference these via the Read tool for continuity across sessions.
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { logError } from "./log.js";

const LOGS_DIR = resolve(process.cwd(), "workspace", "logs");

function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Append a brief entry to today's daily log.
 * Format: ## HH:MM -- [chatName/userName]\n- summary\n
 */
export function appendDailyLog(chatName: string, summary: string): void {
  try {
    ensureLogsDir();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = now.toTimeString().slice(0, 5); // HH:MM
    const logFile = resolve(LOGS_DIR, `${dateStr}.md`);

    const entry = `## ${timeStr} -- [${chatName}]\n- ${summary}\n\n`;
    appendFileSync(logFile, entry);
  } catch (err) {
    logError("bot", "Daily log write failed", err);
  }
}

/** Get the path to the logs directory (for system prompt reference). */
export function getLogsDir(): string {
  return LOGS_DIR;
}
