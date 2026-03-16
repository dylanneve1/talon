/**
 * OpenCode backend — uses the OpenCode SDK as an alternative to Claude Agent SDK.
 *
 * Implements the same QueryBackend interface so it's a drop-in replacement.
 * Manages an OpenCode server process and routes queries through it.
 */

import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import type { TalonConfig } from "../../util/config.js";
import type { QueryParams, QueryResult } from "../../core/types.js";
import { getSession, incrementTurns, recordUsage, setSessionId, setSessionName, resetSession } from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { getRecentHistory } from "../../storage/history.js";
import { classify } from "../../core/errors.js";
import { log, logError, logWarn } from "../../util/log.js";

// ── State ───────────────────────────────────────────────────────────────────

let config: TalonConfig;
let client: OpencodeClient | null = null;
let serverHandle: { url: string; close(): void } | null = null;
let gatewayPortFn: () => number = () => 19876;

export function initOpenCodeAgent(cfg: TalonConfig, getGatewayPort?: () => number): void {
  config = cfg;
  if (getGatewayPort) gatewayPortFn = getGatewayPort;
}

// ── Server lifecycle ────────────────────────────────────────────────────────

async function ensureServer(): Promise<OpencodeClient> {
  if (client) return client;

  log("agent", "Starting OpenCode server...");
  const result = await createOpencode({
    port: 4096,
    timeout: 10_000,
  });
  client = result.client;
  serverHandle = result.server;
  log("agent", `OpenCode server running at ${result.server.url}`);

  // Register our MCP tools server with OpenCode
  try {
    const toolsPath = new URL("../claude-sdk/tools.ts", import.meta.url).pathname;
    await client.mcp.add({
      body: {
        name: "talon-tools",
        config: {
          type: "local" as const,
          command: ["node", "--import", "tsx", toolsPath],
          environment: {
            TALON_BRIDGE_URL: `http://127.0.0.1:${gatewayPortFn()}`,
          },
        },
      },
    });
    log("agent", "Registered talon-tools MCP server with OpenCode");
  } catch (err) {
    logWarn("agent", `MCP registration failed (tools may not be available): ${err instanceof Error ? err.message : err}`);
  }

  return client;
}

export function stopOpenCodeServer(): void {
  if (serverHandle) {
    serverHandle.close();
    serverHandle = null;
    client = null;
    log("agent", "OpenCode server stopped");
  }
}

// ── Session management ──────────────────────────────────────────────────────

async function ensureSession(oc: OpencodeClient, chatId: string): Promise<string> {
  const session = getSession(chatId);

  if (session.sessionId) {
    // Verify session still exists
    try {
      await oc.session.get({ path: { id: session.sessionId } });
      return session.sessionId;
    } catch {
      logWarn("agent", `[${chatId}] Session ${session.sessionId} expired, creating new`);
      resetSession(chatId);
    }
  }

  // Create new session
  const resp = await oc.session.create({
    body: { title: `Chat ${chatId}` },
  });

  // Extract session ID from response
  const data = resp.data as Record<string, unknown> | undefined;
  const newId = (data?.id as string) ?? String(Date.now());
  setSessionId(chatId, newId);
  log("agent", `[${chatId}] Created OpenCode session: ${newId}`);
  return newId;
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleMessage(params: QueryParams): Promise<QueryResult> {
  if (!config) throw new Error("OpenCode agent not initialized");

  const { chatId, text, senderName, isGroup, onTextBlock } = params;
  const t0 = Date.now();

  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.model;

  // Resolve provider and model ID
  const providerID = activeModel.includes("gpt") ? "openai"
    : activeModel.includes("gemini") ? "google"
    : "anthropic";
  const modelID = activeModel;

  const oc = await ensureServer();
  const sessionId = await ensureSession(oc, chatId);

  // Build prompt with group context
  const msgIdHint = params.messageId ? ` [msg_id:${params.messageId}]` : "";
  let continuityPrefix = "";
  const session = getSession(chatId);
  if (session.turns === 0) {
    const recent = getRecentHistory(chatId, 3);
    if (recent.length > 0) {
      const ctx = recent.map((m) => `[${new Date(m.timestamp).toISOString().slice(11, 16)}] ${m.senderName}: ${m.text.slice(0, 300)}`).join("\n");
      continuityPrefix = `[Session resumed — recent context:\n${ctx}]\n\n`;
    }
  }

  const prompt = isGroup
    ? `${continuityPrefix}[${senderName}]${msgIdHint}: ${text}`
    : `${continuityPrefix}${text}${msgIdHint}`;

  log("agent", `[${chatId}] <- ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`);

  try {
    const resp = await oc.session.prompt({
      body: {
        parts: [{ type: "text" as const, text: prompt }],
        model: { providerID, modelID },
        system: config.systemPrompt,
      },
      path: { id: sessionId },
    });

    // Extract text from response parts
    const data = resp.data as Record<string, unknown> | undefined;
    const parts = (data?.parts as Array<Record<string, unknown>>) ?? [];
    let responseText = "";
    let toolCalls = 0;

    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string") {
        if (responseText && onTextBlock) {
          await onTextBlock(responseText);
        }
        responseText = part.text;
      } else if (part.type === "tool") {
        toolCalls++;
      }
    }

    const durationMs = Date.now() - t0;

    // Persist session state
    incrementTurns(chatId);
    recordUsage(chatId, {
      inputTokens: 0, // OpenCode doesn't expose token counts in the same way
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      durationMs,
      model: activeModel,
    });

    if (session.turns === 0 && text) {
      const cleanText = text.replace(/^\[.*?\]\s*/g, "").replace(/\[msg_id:\d+\]\s*/g, "").trim();
      if (cleanText) {
        setSessionName(chatId, cleanText.length > 30 ? cleanText.slice(0, 30) + "..." : cleanText);
      }
    }

    log("agent", `[${chatId}] -> ${responseText.slice(0, 80)}${responseText.length > 80 ? "..." : ""} (${durationMs}ms${toolCalls > 0 ? ` tools=${toolCalls}` : ""})`);

    return {
      text: responseText.trim(),
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  } catch (err) {
    const classified = classify(err);
    logError("agent", `[${chatId}] OpenCode error: ${classified.message}`);
    throw classified;
  }
}
