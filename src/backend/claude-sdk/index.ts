import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TalonConfig } from "../../util/config.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  resetSession,
  setSessionId,
  setSessionName,
} from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { getRecentHistory } from "../../storage/history.js";
import { resolve } from "node:path";
import { classify } from "../../core/errors.js";
import { log, logError, logWarn } from "../../util/log.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type HandleMessageParams = {
  chatId: string;
  text: string;
  senderName: string;
  isGroup?: boolean;
  /** Telegram message ID of the user's message (for reply_to / react tools). */
  messageId?: number;
  /** Called when a new text block is completed (for multi-message delivery). */
  onTextBlock?: (text: string) => Promise<void>;
  /** Called periodically with accumulated text for streaming edits.
   *  Phase is "thinking" during thinking deltas and "text" during text deltas. */
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
};

export type HandleMessageResult = {
  /** Final accumulated text (may be empty if all text was sent via onTextBlock). */
  text: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** Files created or modified in the workspace during this turn. */
  /** Files explicitly sent via the send_file tool. */
};

// ── State ────────────────────────────────────────────────────────────────────

let config: TalonConfig;
let bridgePortFn: () => number = () => 19876;

export function initAgent(cfg: TalonConfig, getBridgePort?: () => number): void {
  config = cfg;
  if (getBridgePort) bridgePortFn = getBridgePort;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleMessage(
  params: HandleMessageParams,
  _retried = false,
): Promise<HandleMessageResult> {
  if (!config)
    throw new Error("Agent not initialized. Call initAgent() first.");

  const { chatId, text, senderName, isGroup, onTextBlock, onStreamDelta } =
    params;
  const session = getSession(chatId);
  const t0 = Date.now();

  // Per-chat settings override global config
  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.model;
  const activeEffort = chatSettings.effort ?? "adaptive";

  // Map effort level to SDK thinking + effort options
  // SDK supports: thinking: {type: "adaptive"/"enabled"/"disabled"}, effort: "low"/"medium"/"high"/"max"
  const thinkingConfig = (() => {
    switch (activeEffort) {
      case "off":
        return { thinking: { type: "disabled" as const } };
      case "low":
        return {
          thinking: { type: "adaptive" as const },
          effort: "low" as const,
        };
      case "medium":
        return {
          thinking: { type: "adaptive" as const },
          effort: "medium" as const,
        };
      case "high":
        return {
          thinking: { type: "adaptive" as const },
          effort: "high" as const,
        };
      case "max":
        return {
          thinking: { type: "adaptive" as const },
          effort: "max" as const,
        };
      default:
        return { thinking: { type: "adaptive" as const } }; // adaptive default
    }
  })();

  const options = {
    model: activeModel,
    systemPrompt: config.systemPrompt,
    cwd: config.workspace,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    betas: ["context-1m-2025-08-07"],
    ...thinkingConfig,
    mcpServers: {
      "telegram-tools": {
        command: "node",
        args: [
          "--import",
          "tsx",
          resolve(import.meta.dirname ?? ".", "tools.ts"),
        ],
        env: {
          TALON_BRIDGE_URL: `http://127.0.0.1:${bridgePortFn()}`,
        },
      },
    },
    ...(session.sessionId ? { resume: session.sessionId } : {}),
  };

  const msgIdHint = params.messageId ? ` [msg_id:${params.messageId}]` : "";

  // Session continuity: on the first turn after a restart (session exists but turns=0),
  // prepend the last 3 messages from history so Claude has context
  let continuityPrefix = "";
  if (session.sessionId && session.turns === 0) {
    const recentMsgs = getRecentHistory(chatId, 3);
    if (recentMsgs.length > 0) {
      const contextLines = recentMsgs
        .map((m) => {
          const time = new Date(m.timestamp).toISOString().slice(11, 16);
          return `[${time}] ${m.senderName}: ${m.text.slice(0, 300)}`;
        })
        .join("\n");
      continuityPrefix = `[Session resumed — recent conversation context:\n${contextLines}]\n\n`;
    }
  }

  const prompt = isGroup
    ? `${continuityPrefix}[${senderName}]${msgIdHint}: ${text}`
    : `${continuityPrefix}${text}${msgIdHint}`;
  log(
    "agent",
    `[${chatId}] <- ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`,
  );

  // SDK types are not fully exported; cast options at the boundary
  const qi = query({ prompt, options: options as Parameters<typeof query>[0]["options"] });

  let currentBlockText = "";
  let allResponseText = "";
  let newSessionId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let toolCalls = 0;

  // Streaming throttle
  let lastStreamUpdate = 0;
  const STREAM_INTERVAL = 1000;

  try {
    for await (const message of qi) {
      const msg = message as Record<string, unknown>;
      const type = msg.type as string;

      // Session ID capture
      if (
        type === "system" &&
        msg.subtype === "init" &&
        typeof msg.session_id === "string"
      ) {
        newSessionId = msg.session_id;
      }

      // Stream text deltas and thinking deltas
      if (type === "stream_event" && onStreamDelta) {
        const event = msg.event as Record<string, unknown> | undefined;
        if (event?.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (
            delta?.type === "thinking_delta" &&
            typeof delta.thinking === "string"
          ) {
            // Thinking phase: notify but don't accumulate text
            const now = Date.now();
            if (now - lastStreamUpdate >= STREAM_INTERVAL) {
              lastStreamUpdate = now;
              onStreamDelta(currentBlockText, "thinking");
            }
          } else if (
            delta?.type === "text_delta" &&
            typeof delta.text === "string"
          ) {
            currentBlockText += delta.text;
            const now = Date.now();
            if (now - lastStreamUpdate >= STREAM_INTERVAL) {
              lastStreamUpdate = now;
              onStreamDelta(currentBlockText, "text");
            }
          }
        }
      }

      // Complete assistant message — may contain multiple text blocks
      // and tool_use blocks. Each text block before a tool_use is a
      // "progress message" that should be sent immediately.
      if (type === "assistant") {
        const content = (msg.message as { content?: unknown[] })?.content;
        if (Array.isArray(content)) {
          let blockText = "";
          for (const block of content) {
            const b = block as { type: string; text?: string; name?: string };
            if (b.type === "text" && b.text) {
              blockText += b.text;
            }
            if (b.type === "tool_use") {
              toolCalls++;
              // If there's text before this tool call, send it as a progress message
              if (blockText.trim() && onTextBlock) {
                await onTextBlock(blockText.trim());
                allResponseText += blockText;
                blockText = "";
                currentBlockText = "";
              }
            }
          }
          // Remaining text after all tool calls (or if no tool calls)
          if (blockText.trim()) {
            currentBlockText = blockText;
          }
        }
      }

      // Final result
      if (type === "result") {
        const usage = msg.usage as Record<string, number> | undefined;
        if (usage) {
          inputTokens = usage.input_tokens ?? 0;
          outputTokens = usage.output_tokens ?? 0;
          cacheRead = usage.cache_read_input_tokens ?? 0;
          cacheWrite = usage.cache_creation_input_tokens ?? 0;
        }
        // If we still have unsent text and no streaming captured it
        if (
          !allResponseText &&
          !currentBlockText &&
          typeof msg.result === "string"
        ) {
          currentBlockText = msg.result;
        }
      }
    }
  } catch (err) {
    const classified = classify(err);
    if (classified.reason === "session_expired" && !_retried) {
      logWarn(
        "agent",
        `[${chatId}] Stale session, retrying with fresh session`,
      );
      resetSession(chatId);
      // Auto-retry with fresh session — don't make the user resend
      return handleMessage(params, true);
    }
    logError("agent", `[${chatId}] SDK error: ${classified.message}`);
    throw classified;
  }

  // Persist session and usage
  const durationMs = Date.now() - t0;
  if (newSessionId) setSessionId(chatId, newSessionId);
  incrementTurns(chatId);
  recordUsage(chatId, {
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    durationMs,
    model: activeModel,
  });

  // Set a descriptive session name from the first message
  if (session.turns === 0 && text) {
    // Strip metadata prefixes like [DM from ...] or [Name]:
    const cleanText = text
      .replace(/^\[.*?\]\s*/g, "")
      .replace(/\[msg_id:\d+\]\s*/g, "")
      .trim();
    if (cleanText) {
      const name =
        cleanText.length > 30 ? cleanText.slice(0, 30) + "..." : cleanText;
      setSessionName(chatId, name);
    }
  }

  // The remaining currentBlockText is the final response text
  allResponseText += currentBlockText;

  const totalPrompt = inputTokens + cacheRead + cacheWrite;
  const cacheHitPct =
    totalPrompt > 0 ? Math.round((cacheRead / totalPrompt) * 100) : 0;

  log(
    "agent",
    `[${chatId}] -> ${allResponseText.slice(0, 80)}${allResponseText.length > 80 ? "..." : ""} ` +
      `(${durationMs}ms, in=${inputTokens} out=${outputTokens} cache=${cacheHitPct}%` +
      `${toolCalls > 0 ? ` tools=${toolCalls}` : ""})`,
  );

  return {
    text: allResponseText.trim(),
    durationMs,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
  };
}
