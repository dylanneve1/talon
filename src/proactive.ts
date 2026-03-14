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

let config: TalonConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const registeredChats = new Set<string>();

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
    console.log(`[proactive] Loaded ${registeredChats.size} registered chat(s) from settings`);
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

  console.log(`[proactive] Timer started: every ${Math.round(ms / 60000)}m`);
  timer = setInterval(() => {
    runProactiveCheck().catch((err) => {
      console.error("[proactive] Check failed:", err instanceof Error ? err.message : err);
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

    try {
      // Set bridge context for this chat
      bridgeSetContext(numericChatId, botInstance, inputFileClass);

      const session = getSession(chatId);
      const options: Record<string, unknown> = {
        model: config.model,
        systemPrompt: config.systemPrompt +
          "\n\n## PROACTIVE MODE\n" +
          "You are checking in on a chat. Read recent messages with read_chat_history.\n" +
          "If there's something interesting you can add to, react to a message or send a brief response.\n" +
          "If there's nothing to respond to, do nothing — don't force a response.\n" +
          "Be natural. Don't announce that you're checking in.\n" +
          "Only respond if you genuinely have something to add.",
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

      const qi = query({
        prompt: "[PROACTIVE CHECK] Read recent chat history and decide if you want to respond to anything.",
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

      console.log(`[proactive] Checked chat ${chatId}`);
    } catch (err) {
      console.error(`[proactive] Chat ${chatId} failed:`, err instanceof Error ? err.message : err);
    } finally {
      bridgeClearContext?.();
    }
  }
}
