import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TalonConfig } from "./config.js";
import { getSession, incrementTurns, recordUsage, setSessionId } from "./sessions.js";
import { readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export type HandleMessageParams = {
  chatId: string;
  text: string;
  senderName: string;
  isGroup?: boolean;
  /** Called when a new text block is completed (for multi-message delivery). */
  onTextBlock?: (text: string) => Promise<void>;
  /** Called periodically with accumulated text for streaming edits. */
  onStreamDelta?: (accumulated: string) => void;
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

function snapshotWorkspace(dir: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  try {
    scanDir(dir, dir, snapshot);
  } catch {
    // workspace might not exist yet
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

  const options: Record<string, unknown> = {
    model: config.model,
    systemPrompt: config.systemPrompt,
    cwd: config.workspace,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    betas: ["context-1m-2025-08-07"],
    maxThinkingTokens: config.maxThinkingTokens,
  };

  if (session.sessionId) {
    options.resume = session.sessionId;
  }

  const prompt = isGroup ? `[${senderName}]: ${text}` : text;
  console.log(`[${chatId}] ← ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}`);

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

      // Stream text deltas
      if (type === "stream_event" && onStreamDelta) {
        const event = msg.event as Record<string, unknown> | undefined;
        if (event?.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            currentBlockText += delta.text;
            const now = Date.now();
            if (now - lastStreamUpdate >= STREAM_INTERVAL) {
              lastStreamUpdate = now;
              onStreamDelta(currentBlockText);
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
      console.warn(`[${chatId}] Stale session, clearing: ${errMsg.slice(0, 100)}`);
      const { resetSession } = await import("./sessions.js");
      resetSession(chatId);
      throw new Error("Session expired. Send your message again to start fresh.");
    }
    console.error(`[${chatId}] SDK error: ${errMsg}`);
    throw err;
  }

  // Persist session and usage
  if (newSessionId) setSessionId(chatId, newSessionId);
  incrementTurns(chatId);
  recordUsage(chatId, { inputTokens, outputTokens, cacheRead, cacheWrite });

  // The remaining currentBlockText is the final response text
  allResponseText += currentBlockText;

  // Detect new files
  const afterFiles = snapshotWorkspace(config.workspace);
  const newFiles = detectNewFiles(beforeFiles, afterFiles, config.workspace);

  const durationMs = Date.now() - t0;
  const totalPrompt = inputTokens + cacheRead + cacheWrite;
  const cacheHitPct = totalPrompt > 0 ? Math.round((cacheRead / totalPrompt) * 100) : 0;

  console.log(
    `[${chatId}] → ${allResponseText.slice(0, 80)}${allResponseText.length > 80 ? "…" : ""} ` +
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
