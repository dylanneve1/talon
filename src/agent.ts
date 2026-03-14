import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TalonConfig } from "./config.js";
import { getSession, incrementTurns, setSessionId } from "./sessions.js";
import { readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

export type HandleMessageParams = {
  chatId: string;
  text: string;
  senderName: string;
  isGroup?: boolean;
  /** Called periodically with accumulated response text for streaming UI updates. */
  onStreamUpdate?: (text: string) => void;
};

export type HandleMessageResult = {
  text: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** Files created or modified in the workspace during this turn. */
  newFiles: string[];
};

let config: TalonConfig;

export function initAgent(cfg: TalonConfig): void {
  config = cfg;
}

/**
 * Snapshot files in the workspace directory (shallow, non-recursive for perf).
 * Returns a map of relative path -> mtime.
 */
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
    // Skip hidden dirs, node_modules, sessions.json
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "sessions.json") continue;
    if (entry.isDirectory()) {
      scanDir(base, full, out);
    } else if (entry.isFile()) {
      try {
        const st = statSync(full);
        const rel = full.slice(base.length + 1);
        out.set(rel, st.mtimeMs);
      } catch {
        // skip unreadable
      }
    }
  }
}

export async function handleMessage(params: HandleMessageParams): Promise<HandleMessageResult> {
  if (!config) throw new Error("Agent not initialized. Call initAgent() first.");

  const { chatId, text, senderName, isGroup, onStreamUpdate } = params;
  const session = getSession(chatId);
  const t0 = Date.now();

  // Snapshot workspace before the turn to detect new/modified files
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
  console.log(`[${chatId}] <- ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`);

  const qi = query({ prompt, options: options as never });

  let responseText = "";
  let newSessionId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let toolCalls = 0;

  // Streaming: throttle updates to ~1 per second
  let lastStreamUpdate = 0;
  const STREAM_INTERVAL = 1000;

  try {
    for await (const message of qi) {
      const msg = message as Record<string, unknown>;
      const type = msg.type as string;

      // Capture session ID from system/init
      if (type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
        newSessionId = msg.session_id;
      }

      // Stream text deltas for real-time updates
      if (type === "stream_event" && onStreamUpdate) {
        const event = msg.event as Record<string, unknown> | undefined;
        if (event && event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
            responseText += delta.text;
            const now = Date.now();
            if (now - lastStreamUpdate >= STREAM_INTERVAL) {
              lastStreamUpdate = now;
              onStreamUpdate(responseText);
            }
          }
        }
      }

      // Capture assistant text from complete messages (fallback / final)
      if (type === "assistant") {
        const content = (msg.message as { content?: unknown[] })?.content;
        if (Array.isArray(content)) {
          // If we already got text from streaming, don't double-count.
          // But we still need to track tool calls.
          let assistantText = "";
          for (const block of content) {
            const b = block as { type: string; text?: string; name?: string };
            if (b.type === "text" && b.text) {
              assistantText += b.text;
            }
            if (b.type === "tool_use") {
              toolCalls++;
            }
          }
          // If streaming didn't capture text, use the complete message
          if (!responseText && assistantText) {
            responseText = assistantText;
          }
        }
      }

      // Capture final result
      if (type === "result") {
        if (!responseText && typeof msg.result === "string") {
          responseText = msg.result;
        }
        const usage = msg.usage as Record<string, number> | undefined;
        if (usage) {
          inputTokens = usage.input_tokens ?? 0;
          outputTokens = usage.output_tokens ?? 0;
          cacheRead = usage.cache_read_input_tokens ?? 0;
          cacheWrite = usage.cache_creation_input_tokens ?? 0;
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Handle stale session -- reset and suggest retry
    if (/session|expired|invalid|resume/i.test(errMsg)) {
      console.warn(`[${chatId}] Stale session, clearing: ${errMsg.slice(0, 100)}`);
      const { resetSession } = await import("./sessions.js");
      resetSession(chatId);
      throw new Error("Session expired. Send your message again to start fresh.");
    }
    console.error(`[${chatId}] SDK error: ${errMsg}`);
    throw err;
  }

  // Persist session state
  if (newSessionId) setSessionId(chatId, newSessionId);
  incrementTurns(chatId);

  // Detect new/modified files in workspace
  const afterFiles = snapshotWorkspace(config.workspace);
  const newFiles: string[] = [];
  for (const [rel, mtime] of afterFiles) {
    const before = beforeFiles.get(rel);
    if (before === undefined || mtime > before) {
      newFiles.push(resolve(config.workspace, rel));
    }
  }

  const durationMs = Date.now() - t0;
  const totalPrompt = inputTokens + cacheRead + cacheWrite;
  const cacheHitPct = totalPrompt > 0 ? Math.round((cacheRead / totalPrompt) * 100) : 0;

  console.log(
    `[${chatId}] -> ${responseText.slice(0, 80)}${responseText.length > 80 ? "..." : ""} ` +
      `(${durationMs}ms, in=${inputTokens} out=${outputTokens} cache=${cacheHitPct}%` +
      `${toolCalls > 0 ? ` tools=${toolCalls}` : ""}` +
      `${newFiles.length > 0 ? ` files=${newFiles.length}` : ""})`,
  );

  return {
    text: responseText.trim(),
    durationMs,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    newFiles,
  };
}
