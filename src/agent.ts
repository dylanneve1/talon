import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TalonConfig } from "./config.js";
import { getSession, incrementTurns, recordUsage, setSessionId, setLastBotMessageId } from "./sessions.js";
import { getBridgePort } from "./bridge.js";
import { getChatSettings } from "./chat-settings.js";
import { getRecentHistory } from "./history.js";
import { readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { log, logError, logWarn } from "./log.js";

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
  newFiles: string[];
  /** Files explicitly sent via the send_file tool. */
  sentFiles: string[];
};

// ── State ────────────────────────────────────────────────────────────────────

let config: TalonConfig;

export function initAgent(cfg: TalonConfig): void {
  config = cfg;
}

// ── Workspace file tracking ──────────────────────────────────────────────────

/** Only scan directories that contain user-facing output files. */
const SCAN_SUBDIRS = ["files", "scripts", "data"];

function snapshotWorkspace(dir: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const sub of SCAN_SUBDIRS) {
    const subDir = join(dir, sub);
    try {
      scanDir(dir, subDir, snapshot);
    } catch {
      // subdirectory might not exist yet
    }
  }
  return snapshot;
}

function scanDir(base: string, dir: string, out: Map<string, number>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (
      entry.name.startsWith(".") ||
      entry.name === "node_modules" ||
      entry.name === "sessions.json"
    )
      continue;
    if (entry.isDirectory()) {
      scanDir(base, full, out);
    } else if (entry.isFile()) {
      try {
        const st = statSync(full);
        out.set(full.slice(base.length + 1), st.mtimeMs);
      } catch {
        // skip
      }
    }
  }
}

function detectNewFiles(
  before: Map<string, number>,
  after: Map<string, number>,
  workspace: string,
): string[] {
  const newFiles: string[] = [];
  for (const [rel, mtime] of after) {
    const prev = before.get(rel);
    if (prev === undefined || mtime > prev) {
      newFiles.push(resolve(workspace, rel));
    }
  }
  return newFiles;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleMessage(
  params: HandleMessageParams,
): Promise<HandleMessageResult> {
  if (!config) throw new Error("Agent not initialized. Call initAgent() first.");

  const { chatId, text, senderName, isGroup, onTextBlock, onStreamDelta } = params;
  const session = getSession(chatId);
  const t0 = Date.now();

  const beforeFiles = snapshotWorkspace(config.workspace);

  // Per-chat settings override global config
  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.model;
  const activeEffort = chatSettings.effort ?? "adaptive";

  // Map effort level to SDK thinking + effort options
  // SDK supports: thinking: {type: "adaptive"/"enabled"/"disabled"}, effort: "low"/"medium"/"high"/"max"
  const thinkingConfig = (() => {
    switch (activeEffort) {
      case "off": return { thinking: { type: "disabled" as const } };
      case "low": return { thinking: { type: "adaptive" as const }, effort: "low" as const };
      case "medium": return { thinking: { type: "adaptive" as const }, effort: "medium" as const };
      case "high": return { thinking: { type: "adaptive" as const }, effort: "high" as const };
      case "max": return { thinking: { type: "adaptive" as const }, effort: "max" as const };
      default: return { thinking: { type: "adaptive" as const } }; // adaptive default
    }
  })();

  const options: Record<string, unknown> = {
    model: activeModel,
    systemPrompt: config.systemPrompt,
    cwd: config.workspace,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    betas: ["context-1m-2025-08-07"],
    ...thinkingConfig,
    // MCP server providing Telegram action tools (send_message, react, reply_to, etc.)
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

  const msgIdHint = params.messageId ? ` [msg_id:${params.messageId}]` : "";

  // Session continuity: on the first turn after a restart (session exists but turns=0),
  // prepend the last 3 messages from history so Claude has context
  let continuityPrefix = "";
  if (session.sessionId && session.turns === 0) {
    const recentMsgs = getRecentHistory(chatId, 3);
    if (recentMsgs.length > 0) {
      const contextLines = recentMsgs.map((m) => {
        const time = new Date(m.timestamp).toISOString().slice(11, 16);
        return `[${time}] ${m.senderName}: ${m.text.slice(0, 300)}`;
      }).join("\n");
      continuityPrefix = `[Session resumed — recent conversation context:\n${contextLines}]\n\n`;
    }
  }

  const prompt = isGroup
    ? `${continuityPrefix}[${senderName}]${msgIdHint}: ${text}`
    : `${continuityPrefix}${text}${msgIdHint}`;
  log("agent", `[${chatId}] <- ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`);

  const qi = query({ prompt, options: options as never });

  let currentBlockText = "";
  let allResponseText = "";
  let newSessionId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let toolCalls = 0;
  const sentFiles: string[] = [];

  // Streaming throttle
  let lastStreamUpdate = 0;
  const STREAM_INTERVAL = 1000;

  try {
    for await (const message of qi) {
      const msg = message as Record<string, unknown>;
      const type = msg.type as string;

      // Session ID capture
      if (type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
        newSessionId = msg.session_id;
      }

      // Stream text deltas and thinking deltas
      if (type === "stream_event" && onStreamDelta) {
        const event = msg.event as Record<string, unknown> | undefined;
        if (event?.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            // Thinking phase: notify but don't accumulate text
            const now = Date.now();
            if (now - lastStreamUpdate >= STREAM_INTERVAL) {
              lastStreamUpdate = now;
              onStreamDelta(currentBlockText, "thinking");
            }
          } else if (delta?.type === "text_delta" && typeof delta.text === "string") {
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
        if (!allResponseText && !currentBlockText && typeof msg.result === "string") {
          currentBlockText = msg.result;
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (/session|expired|invalid|resume/i.test(errMsg)) {
      logWarn("agent", `[${chatId}] Stale session, clearing: ${errMsg.slice(0, 100)}`);
      const { resetSession } = await import("./sessions.js");
      resetSession(chatId);
      throw new Error("Session expired. Send your message again to start fresh.");
    }
    logError("agent", `[${chatId}] SDK error: ${errMsg}`);
    throw err;
  }

  // Persist session and usage
  const durationMs = Date.now() - t0;
  if (newSessionId) setSessionId(chatId, newSessionId);
  incrementTurns(chatId);
  recordUsage(chatId, { inputTokens, outputTokens, cacheRead, cacheWrite, durationMs });

  // The remaining currentBlockText is the final response text
  allResponseText += currentBlockText;

  // Detect new files
  const afterFiles = snapshotWorkspace(config.workspace);
  const newFiles = detectNewFiles(beforeFiles, afterFiles, config.workspace);

  const totalPrompt = inputTokens + cacheRead + cacheWrite;
  const cacheHitPct = totalPrompt > 0 ? Math.round((cacheRead / totalPrompt) * 100) : 0;

  log("agent",
    `[${chatId}] -> ${allResponseText.slice(0, 80)}${allResponseText.length > 80 ? "..." : ""} ` +
      `(${durationMs}ms, in=${inputTokens} out=${outputTokens} cache=${cacheHitPct}%` +
      `${toolCalls > 0 ? ` tools=${toolCalls}` : ""}` +
      `${newFiles.length > 0 ? ` files=${newFiles.length}` : ""})`,
  );

  return {
    text: allResponseText.trim(),
    durationMs,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    newFiles,
    sentFiles,
  };
}
