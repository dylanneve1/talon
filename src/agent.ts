import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TalonConfig } from "./config.js";
import { getSession, incrementTurns, setSessionId } from "./sessions.js";

type HandleMessageParams = {
  chatId: string;
  text: string;
  senderName: string;
  isGroup?: boolean;
};

type HandleMessageResult = {
  text: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
};

let config: TalonConfig;

export function initAgent(cfg: TalonConfig): void {
  config = cfg;
}

export async function handleMessage(params: HandleMessageParams): Promise<HandleMessageResult> {
  if (!config) throw new Error("Agent not initialized. Call initAgent() first.");

  const { chatId, text, senderName, isGroup } = params;
  const session = getSession(chatId);
  const t0 = Date.now();

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

  let responseText = "";
  let newSessionId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let toolCalls = 0;

  try {
    for await (const message of qi) {
      const msg = message as Record<string, unknown>;
      const type = msg.type as string;

      // Capture session ID from system/init
      if (type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
        newSessionId = msg.session_id;
      }

      // Capture assistant text from complete messages
      if (type === "assistant") {
        const content = (msg.message as { content?: unknown[] })?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type: string; text?: string; name?: string };
            if (b.type === "text" && b.text) {
              responseText += b.text;
            }
            if (b.type === "tool_use") {
              toolCalls++;
            }
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
    // Handle stale session — reset and suggest retry
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

  const durationMs = Date.now() - t0;
  const totalPrompt = inputTokens + cacheRead + cacheWrite;
  const cacheHitPct = totalPrompt > 0 ? Math.round((cacheRead / totalPrompt) * 100) : 0;

  console.log(
    `[${chatId}] → ${responseText.slice(0, 80)}${responseText.length > 80 ? "…" : ""} ` +
      `(${durationMs}ms, in=${inputTokens} out=${outputTokens} cache=${cacheHitPct}%` +
      `${toolCalls > 0 ? ` tools=${toolCalls}` : ""})`,
  );

  return {
    text: responseText.trim(),
    durationMs,
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
  };
}
