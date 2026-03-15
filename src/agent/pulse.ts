/**
 * Pulse — conversation-aware engagement.
 *
 * Every N minutes (default 5), checks for new messages in registered chats.
 * If there are new messages, feeds them to Claude to decide whether to respond.
 * Claude can respond, react, or stay silent.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TalonConfig } from "../util/config.js";
import { getSession, setSessionId } from "../storage/sessions.js";
import { getBridgePort, isBridgeBusy } from "../bridge/server.js";
import { resolve } from "node:path";
import {
  setChatProactive,
  getRegisteredProactiveChats,
  getChatSettings,
} from "../storage/chat-settings.js";
import { getRecentHistory, getLatestMessageId } from "../storage/history.js";
import { log, logError } from "../util/log.js";

// ── State ────────────────────────────────────────────────────────────────────

let config: TalonConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const registeredChats = new Set<string>();
const lastCheckMessageId = new Map<string, number>();

let bridgeSetContext: ((chatId: number, bot: unknown, inputFile: unknown) => void) | null = null;
let bridgeClearContext: (() => void) | null = null;
let botInstance: unknown = null;
let inputFileClass: unknown = null;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Public API ───────────────────────────────────────────────────────────────

export function initPulse(params: {
  config: TalonConfig;
  setBridgeContext: (chatId: number, bot: unknown, inputFile: unknown) => void;
  clearBridgeContext: () => void;
  bot: unknown;
  inputFile: unknown;
}): void {
  config = params.config;
  bridgeSetContext = params.setBridgeContext;
  bridgeClearContext = params.clearBridgeContext;
  botInstance = params.bot;
  inputFileClass = params.inputFile;

  for (const chatId of getRegisteredProactiveChats()) {
    registeredChats.add(chatId);
  }
  if (registeredChats.size > 0) {
    log("pulse", `Loaded ${registeredChats.size} registered chat(s)`);
  }
}

export function registerChat(chatId: string): void {
  registeredChats.add(chatId);
  const settings = getChatSettings(chatId);
  if (settings.proactive === undefined) {
    setChatProactive(chatId, true);
  }
}

export function enablePulse(chatId: string): void {
  setChatProactive(chatId, true);
  registeredChats.add(chatId);
}

export function disablePulse(chatId: string): void {
  setChatProactive(chatId, false);
}

export function isPulseEnabled(chatId: string): boolean {
  return getChatSettings(chatId).proactive !== false;
}

export function startPulseTimer(intervalMs?: number): void {
  if (timer) return;
  const envMs = parseInt(process.env.TALON_PULSE_INTERVAL_MS ?? "", 10);
  const ms = intervalMs ?? (envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  if (ms <= 0) return;

  log("pulse", `Started: checking every ${Math.round(ms / 60000)}m`);
  timer = setInterval(() => {
    runPulse().catch((err) => logError("pulse", "Check failed", err));
  }, ms);
}

export function stopPulseTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function runPulse(): Promise<void> {
  if (!config || !bridgeSetContext || !bridgeClearContext || !botInstance) return;
  if (isBridgeBusy()) return;

  for (const chatId of registeredChats) {
    if (!isPulseEnabled(chatId)) continue;
    await pulseChat(chatId);
  }
}

async function pulseChat(chatId: string): Promise<void> {
  if (!config || !bridgeSetContext || !bridgeClearContext || !botInstance) return;
  if (isBridgeBusy()) return;

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

  // Mark as checked
  lastCheckMessageId.set(chatId, latestMsgId);

  const summary = unread
    .map((m) => {
      const time = new Date(m.timestamp).toISOString().slice(11, 16);
      const media = m.mediaType ? ` [${m.mediaType}]` : "";
      return `[${time}] ${m.senderName}${media}: ${m.text.slice(0, 200)}`;
    })
    .join("\n");

  try {
    bridgeSetContext(numericChatId, botInstance, inputFileClass);

    const session = getSession(chatId);
    const chatSettings = getChatSettings(chatId);

    const options: Record<string, unknown> = {
      model: chatSettings.model ?? config.model,
      systemPrompt:
        config.systemPrompt +
        "\n\n## PULSE MODE\n" +
        "You're reading along in a chat. Below are recent messages you haven't seen.\n" +
        "Jump in ONLY if you have something genuinely useful, funny, or interesting to add.\n" +
        "Most of the time, stay silent. You're a participant, not a responder.\n" +
        "Don't announce yourself. Don't say 'I noticed...' or 'I saw...'. Just talk naturally.\n" +
        "A reaction (emoji) is often better than a message.",
      cwd: config.workspace,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      betas: ["context-1m-2025-08-07"],
      thinking: { type: "adaptive" as const },
      effort: "low" as const,
      mcpServers: {
        "telegram-tools": {
          command: "node",
          args: ["--import", "tsx", resolve(import.meta.dirname ?? ".", "../bridge/tools.ts")],
          env: { TALON_BRIDGE_URL: `http://127.0.0.1:${getBridgePort() || 19876}` },
        },
      },
    };

    if (session.sessionId) options.resume = session.sessionId;

    const qi = query({
      prompt: `${unread.length} new message(s):\n\n${summary}`,
      options: options as never,
    });

    let newSessionId: string | undefined;
    for await (const message of qi) {
      const msg = message as Record<string, unknown>;
      if (msg.type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
        newSessionId = msg.session_id;
      }
    }

    if (newSessionId) setSessionId(chatId, newSessionId);
    log("pulse", `Checked ${chatId} (${unread.length} new msgs)`);
  } catch (err) {
    logError("pulse", `Chat ${chatId} failed`, err);
  } finally {
    bridgeClearContext?.();
  }
}
