/**
 * Pulse — conversation-aware engagement.
 *
 * Every N minutes, checks for new messages in registered chats.
 * If there are new messages, feeds them to the dispatcher so Claude
 * can decide whether to respond. Same session, same cache.
 *
 * Knows nothing about the backend or frontend — uses the dispatcher.
 */

import { isBusy, execute } from "./dispatcher.js";
import {
  setChatPulse,
  getRegisteredPulseChats,
  getChatSettings,
} from "../storage/chat-settings.js";
import { getRecentHistory, getLatestMessageId } from "../storage/history.js";
import { log, logError } from "../util/log.js";

// ── State ────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
const registeredChats = new Set<string>();
const lastCheckMessageId = new Map<string, number>();

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let activeIntervalMs = DEFAULT_INTERVAL_MS;

// ── Public API ───────────────────────────────────────────────────────────────

export function initPulse(): void {
  for (const chatId of getRegisteredPulseChats()) {
    registeredChats.add(chatId);
  }
  if (registeredChats.size > 0) {
    log("pulse", `Loaded ${registeredChats.size} registered chat(s)`);
  }
}

export function registerChat(chatId: string): void {
  registeredChats.add(chatId);
}

export function enablePulse(chatId: string): void {
  setChatPulse(chatId, true);
  registeredChats.add(chatId);
}

export function disablePulse(chatId: string): void {
  setChatPulse(chatId, false);
}

export function isPulseEnabled(chatId: string): boolean {
  return getChatSettings(chatId).pulse === true;
}

export function startPulseTimer(intervalMs?: number): void {
  if (timer) return;
  const envMs = parseInt(process.env.TALON_PULSE_INTERVAL_MS ?? "", 10);
  const ms = intervalMs ?? (envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  if (ms <= 0) return;

  activeIntervalMs = ms;
  log("pulse", `Started: checking every ${Math.round(ms / 60000)}m`);
  timer = setInterval(() => {
    runPulse().catch((err) => logError("pulse", "Check failed", err));
  }, ms);
}

/** Reset the pulse timer — call when bot sends a message to avoid
 *  redundant check-ins during active conversation. */
export function resetPulseTimer(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = setInterval(() => {
    runPulse().catch((err) => logError("pulse", "Check failed", err));
  }, activeIntervalMs);
}

export function stopPulseTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function runPulse(): Promise<void> {
  if (isBusy()) return;

  for (const chatId of registeredChats) {
    if (!isPulseEnabled(chatId)) continue;
    await pulseChat(chatId);
  }
}

async function pulseChat(chatId: string): Promise<void> {
  if (isBusy()) return;

  const numericChatId = parseInt(chatId, 10);
  if (isNaN(numericChatId)) return;

  // Any new messages since last check?
  const latestMsgId = getLatestMessageId(chatId);
  const lastChecked = lastCheckMessageId.get(chatId);
  if (latestMsgId === undefined) return;
  if (lastChecked !== undefined && latestMsgId <= lastChecked) return;

  // Get unread messages
  const recent = getRecentHistory(chatId, 15);
  const unread = lastChecked
    ? recent.filter((m) => m.msgId > lastChecked)
    : recent;
  if (unread.length === 0) return;

  // Mark as checked before running
  lastCheckMessageId.set(chatId, latestMsgId);

  const summary = unread
    .map((m) => {
      const time = new Date(m.timestamp).toISOString().slice(11, 16);
      const media = m.mediaType ? ` [${m.mediaType}]` : "";
      return `[msg:${m.msgId} ${time}] ${m.senderName}${media}: ${m.text.slice(0, 200)}`;
    })
    .join("\n");

  try {
    const prompt =
      `[System: Pulse check — ${unread.length} new message(s) since last check. ` +
      `Read them and decide if you want to jump in. Stay silent if nothing to add. ` +
      `Don't announce yourself.]\n\n${summary}`;

    await execute({
      chatId,
      numericChatId,
      prompt,
      senderName: "System",
      isGroup: true,
      source: "pulse",
    });

    log("pulse", `Checked ${chatId} (${unread.length} new msgs)`);
  } catch (err) {
    logError("pulse", `Chat ${chatId} failed`, err);
  }
}
