/**
 * Proactive engagement — periodically reads recent chat messages
 * and decides whether to respond or react. Runs on a configurable
 * interval (default: 1 hour). Can be disabled per-chat or globally.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TalonConfig } from "./config.js";
import { getSession, setSessionId } from "./sessions.js";
import { getBridgePort } from "./bridge.js";
import { resolve } from "node:path";
import { setChatProactive, getRegisteredProactiveChats, getChatSettings } from "./chat-settings.js";
import { getRecentHistory, getLatestMessageId } from "./history.js";
import { log, logError } from "./log.js";

let config: TalonConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const registeredChats = new Set<string>();

/** Track the last message ID seen during each proactive check, per chat. */
const lastProactiveCheckMessageId = new Map<string, number>();

// Store a reference to setBridgeContext so we can set context for proactive actions
let bridgeSetContext: ((chatId: number, bot: unknown, inputFile: unknown) => void) | null = null;
let bridgeClearContext: (() => void) | null = null;
let botInstance: unknown = null;
let inputFileClass: unknown = null;

export function initProactive(params: {
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

  // Load persisted proactive registrations from chat settings
  for (const chatId of getRegisteredProactiveChats()) {
    registeredChats.add(chatId);
  }
  if (registeredChats.size > 0) {
    log("proactive", `Loaded ${registeredChats.size} registered chat(s) from settings`);
  }
}

export function registerChatForProactive(chatId: string): void {
  registeredChats.add(chatId);
  // Persist: mark as proactive-enabled unless explicitly disabled
  const settings = getChatSettings(chatId);
  if (settings.proactive === undefined) {
    setChatProactive(chatId, true);
  }
}

export function disableProactive(chatId: string): void {
  setChatProactive(chatId, false);
}

export function enableProactive(chatId: string): void {
  setChatProactive(chatId, true);
}

export function isProactiveEnabled(chatId: string): boolean {
  const settings = getChatSettings(chatId);
  // Default to true if not explicitly set (registered chats are enabled by default)
  return settings.proactive !== false;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startProactiveTimer(intervalMs?: number): void {
  if (timer) return;
  const envMs = parseInt(process.env.TALON_PROACTIVE_INTERVAL_MS ?? "", 10);
  const ms = intervalMs ?? (envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  if (ms <= 0) return;

  log("proactive", `Timer started: every ${Math.round(ms / 60000)}m`);
  timer = setInterval(() => {
    runProactiveCheck().catch((err) => {
      logError("proactive", "Check failed", err);
    });
  }, ms);
}

export function stopProactiveTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function runProactiveCheck(): Promise<void> {
  if (!config || !bridgeSetContext || !bridgeClearContext || !botInstance) return;

  for (const chatId of registeredChats) {
    if (!isProactiveEnabled(chatId)) continue;

    const numericChatId = parseInt(chatId, 10);
    if (isNaN(numericChatId)) continue;

    // Check for new messages since last proactive check using in-memory buffer
    const latestMsgId = getLatestMessageId(chatId);
    const lastCheckedId = lastProactiveCheckMessageId.get(chatId);

    if (latestMsgId === undefined) {
      // No messages in buffer at all — skip
      continue;
    }

    if (lastCheckedId !== undefined && latestMsgId <= lastCheckedId) {
      // No new messages since last check — skip
      continue;
    }

    // Build a summary of unread messages from the in-memory buffer
    const recentMessages = getRecentHistory(chatId, 10);
    const unreadMessages = lastCheckedId
      ? recentMessages.filter((m) => m.msgId > lastCheckedId)
      : recentMessages;

    if (unreadMessages.length === 0) continue;

    const messageSummary = unreadMessages
      .map((m) => {
        const time = new Date(m.timestamp).toISOString().slice(11, 16);
        const media = m.mediaType ? ` [${m.mediaType}]` : "";
        return `[${time}] ${m.senderName}${media}: ${m.text.slice(0, 200)}`;
      })
      .join("\n");

    // Update the last checked ID before running the check
    lastProactiveCheckMessageId.set(chatId, latestMsgId);

    try {
      // Set bridge context for this chat
      bridgeSetContext(numericChatId, botInstance, inputFileClass);

      const session = getSession(chatId);
      const chatSettings = getChatSettings(chatId);
      const activeModel = chatSettings.model ?? config.model;

      const options: Record<string, unknown> = {
        model: activeModel,
        systemPrompt: config.systemPrompt +
          "\n\n## PROACTIVE MODE\n" +
          "You are checking in on a chat. Below are recent unread messages.\n" +
          "If there's something interesting you can add to, react to a message or send a brief response.\n" +
          "If there's nothing to respond to, do nothing — don't force a response.\n" +
          "Be natural. Don't announce that you're checking in.\n" +
          "Only respond if you genuinely have something to add.\n" +
          "You can also use read_chat_history for more context if needed.",
        cwd: config.workspace,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        betas: ["context-1m-2025-08-07"],
        maxThinkingTokens: 4000,
        mcpServers: {
          "telegram-tools": {
            command: "node",
            args: ["--import", "tsx", resolve(import.meta.dirname ?? ".", "mcp-telegram.ts")],
            env: { TALON_BRIDGE_URL: `http://127.0.0.1:${getBridgePort() || 19876}` },
          },
        },
      };

      if (session.sessionId) {
        options.resume = session.sessionId;
      }

      const prompt =
        `[PROACTIVE CHECK] ${unreadMessages.length} new message(s) since last check:\n\n` +
        messageSummary +
        "\n\nDecide if you want to respond to or react to anything. If not, do nothing.";

      const qi = query({
        prompt,
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

      log("proactive", `Checked chat ${chatId} (${unreadMessages.length} new msgs)`);
    } catch (err) {
      logError("proactive", `Chat ${chatId} failed`, err);
    } finally {
      bridgeClearContext?.();
    }
  }
}
