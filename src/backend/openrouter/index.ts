/**
 * OpenRouter backend — uses the OpenAI Agents SDK with OpenRouter as the
 * model provider. Drop-in replacement for claude-sdk/opencode backends.
 *
 * Implements the QueryBackend interface so it's a drop-in replacement.
 * Uses OpenAI's Chat Completions API via OpenRouter's compatible endpoint.
 */

import { OpenAI } from "openai";
import {
  Agent,
  run,
  MCPServerStdio,
  setDefaultOpenAIClient,
  setOpenAIAPI,
  setTracingDisabled,
  type RunToolCallItem,
  type RunMessageOutputItem,
} from "@openai/agents";
import type { TalonConfig } from "../../util/config.js";
import type { QueryParams, QueryResult } from "../../core/types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionName,
} from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { getRecentHistory } from "../../storage/history.js";
import {
  getPluginMcpServers,
  getPluginPromptAdditions,
} from "../../core/plugin.js";
import { rebuildSystemPrompt } from "../../util/config.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { formatSmartTimestamp, formatFullDatetime } from "../../util/time.js";
import { resolve } from "node:path";

// ── State ───────────────────────────────────────────────────────────────────

let config: TalonConfig;
let bridgePortFn: () => number = () => 19876;
let initialized = false;

export function initOpenRouterAgent(
  cfg: TalonConfig,
  getBridgePort?: () => number,
): void {
  config = cfg;
  if (getBridgePort) bridgePortFn = getBridgePort;

  // Configure OpenAI SDK to point at OpenRouter
  const apiKey = cfg.openrouterApiKey;
  if (!apiKey) {
    throw new Error(
      "OpenRouter backend requires openrouterApiKey in config",
    );
  }

  const client = new OpenAI({
    baseURL: cfg.openrouterBaseUrl || "https://openrouter.ai/api/v1",
    apiKey,
  });

  setDefaultOpenAIClient(client);
  setOpenAIAPI("chat_completions");
  setTracingDisabled(true); // No OpenAI tracing when using OpenRouter
  initialized = true;
}

// ── Build MCP servers ────────────────────────────────────────────────────────

async function buildMcpServers(
  chatId: string,
): Promise<MCPServerStdio[]> {
  const servers: MCPServerStdio[] = [];
  const bridgeUrl = `http://127.0.0.1:${bridgePortFn()}`;
  const mcpEnv: Record<string, string> = {
    TALON_BRIDGE_URL: bridgeUrl,
    TALON_CHAT_ID: chatId,
  };

  // Resolve tsx from the package root
  const tsxImport = resolve(
    import.meta.dirname ?? ".",
    "../../../node_modules/tsx/dist/esm/index.mjs",
  );
  const toolsPath = resolve(
    import.meta.dirname ?? ".",
    "../claude-sdk/tools.ts",
  );

  // Telegram tools
  const frontends = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];

  if (frontends.includes("telegram")) {
    servers.push(
      new MCPServerStdio({
        name: "telegram-tools",
        command: process.platform === "win32" ? "npx" : "node",
        args:
          process.platform === "win32"
            ? ["tsx", toolsPath]
            : ["--import", tsxImport, toolsPath],
        env: mcpEnv,
        cacheToolsList: true,
      }),
    );
  }

  if (frontends.includes("teams")) {
    const teamsToolsPath = resolve(
      import.meta.dirname ?? ".",
      "../../frontend/teams/tools.ts",
    );
    servers.push(
      new MCPServerStdio({
        name: "teams-tools",
        command: process.platform === "win32" ? "npx" : "node",
        args:
          process.platform === "win32"
            ? ["tsx", teamsToolsPath]
            : ["--import", tsxImport, teamsToolsPath],
        env: mcpEnv,
        cacheToolsList: true,
      }),
    );
  }

  // Plugin MCP servers
  const pluginServers = getPluginMcpServers(bridgeUrl, chatId);
  for (const [name, serverConfig] of Object.entries(pluginServers)) {
    servers.push(
      new MCPServerStdio({
        name,
        command: serverConfig.command,
        args: serverConfig.args,
        env: { ...mcpEnv, ...serverConfig.env },
        cacheToolsList: true,
      }),
    );
  }

  // Connect all servers
  await Promise.all(servers.map((s) => s.connect()));
  return servers;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  if (!initialized) {
    throw new Error("OpenRouter agent not initialized. Call initOpenRouterAgent() first.");
  }

  const {
    chatId,
    text,
    senderName,
    isGroup,
    onTextBlock,
    onStreamDelta,
    onToolUse,
  } = params;
  const session = getSession(chatId);
  const t0 = Date.now();

  // Rebuild system prompt on first turn
  if (session.turns === 0) {
    rebuildSystemPrompt(config, getPluginPromptAdditions());
  }

  // Per-chat model override
  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.openrouterModel ?? "openai/gpt-4.1-mini";

  // Build MCP servers
  let mcpServers: MCPServerStdio[] = [];
  try {
    mcpServers = await buildMcpServers(chatId);
  } catch (err) {
    logWarn("agent", `[${chatId}] Failed to start MCP servers: ${err}`);
  }

  // Build prompt with metadata
  const msgIdHint = params.messageId ? ` [msg_id:${params.messageId}]` : "";
  const nowTag = `[${formatFullDatetime()}]`;

  // Session continuity
  let continuityPrefix = "";
  if (!session.sessionId && session.turns > 0) {
    const recentMsgs = getRecentHistory(chatId, 10);
    if (recentMsgs.length > 0) {
      const contextLines = recentMsgs
        .map((m) => {
          const time = formatSmartTimestamp(m.timestamp);
          return `[${time}] ${m.senderName}: ${m.text.slice(0, 300)}`;
        })
        .join("\n");
      continuityPrefix = `[Session resumed — recent conversation context:\n${contextLines}]\n\n`;
    }
  }

  const prompt = isGroup
    ? `${continuityPrefix}${nowTag} [${senderName}]${msgIdHint}: ${text}`
    : `${continuityPrefix}${nowTag}${msgIdHint} ${text}`;

  log("agent", `[${chatId}] <- (${text.length} chars) model=${activeModel}`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  // Create agent
  const agent = new Agent({
    name: "Talon",
    instructions: config.systemPrompt,
    model: activeModel,
    mcpServers,
    // Allow many turns for tool use
    modelSettings: {
      temperature: 0.7,
    },
  });

  let allResponseText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;

  // Streaming throttle
  let lastStreamUpdate = 0;
  const STREAM_INTERVAL = 1000;

  try {
    const result = await run(agent, prompt, {
      stream: true,
      maxTurns: 30,
    });

    // Process streaming events
    for await (const event of result) {
      // Text deltas
      if (event.type === "raw_model_stream_event") {
        const data = event.data as Record<string, unknown>;
        // Chat completions streaming — delta content
        if (data.type === "output_text_delta" && typeof data.delta === "string") {
          allResponseText += data.delta;
          const now = Date.now();
          if (now - lastStreamUpdate >= STREAM_INTERVAL && onStreamDelta) {
            lastStreamUpdate = now;
            onStreamDelta(allResponseText, "text");
          }
        }
      }

      // Tool calls
      if (event.type === "run_item_stream_event") {
        if (event.name === "tool_called" && onToolUse) {
          const item = event.item as RunToolCallItem;
          toolCalls++;
          try {
            const rawItem = item.rawItem as Record<string, unknown>;
            const name = (rawItem.name as string) || "unknown";
            const args =
              typeof rawItem.arguments === "string"
                ? JSON.parse(rawItem.arguments)
                : (rawItem.arguments as Record<string, unknown>) ?? {};
            onToolUse(name, args);
          } catch {
            /* non-fatal */
          }
        }

        // Text output (complete message block) — send as progress
        if (event.name === "message_output_created" && onTextBlock) {
          const item = event.item as RunMessageOutputItem;
          try {
            const rawItem = item.rawItem as Record<string, unknown>;
            const content = rawItem.content;
            if (typeof content === "string" && content.trim()) {
              await onTextBlock(content.trim());
            }
          } catch {
            /* non-fatal */
          }
        }
      }
    }

    // Get usage from the completed result
    // The streamed result may not have detailed token counts for OpenRouter,
    // but we capture what we can
    const usage = (result as unknown as Record<string, unknown>).usage as
      | Record<string, number>
      | undefined;
    if (usage) {
      inputTokens = usage.inputTokens ?? usage.prompt_tokens ?? 0;
      outputTokens = usage.outputTokens ?? usage.completion_tokens ?? 0;
    }

    // If the stream didn't capture text, use finalOutput
    if (!allResponseText && result.finalOutput) {
      allResponseText = result.finalOutput;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("agent", `[${chatId}] Error: ${msg}`);

    // Simple retry on transient errors
    if (!_retried && (msg.includes("429") || msg.includes("500") || msg.includes("503"))) {
      logWarn("agent", `[${chatId}] Retrying after transient error...`);
      await new Promise((r) => setTimeout(r, 2000));
      return handleMessage(params, true);
    }

    throw err;
  } finally {
    // Clean up MCP servers
    for (const server of mcpServers) {
      try {
        await server.close();
      } catch {
        /* ignore cleanup errors */
      }
    }
  }

  // Persist session and usage
  const durationMs = Date.now() - t0;
  incrementTurns(chatId);
  recordUsage(chatId, {
    inputTokens,
    outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    durationMs,
    model: activeModel,
  });

  // Set session name from first message
  if (session.turns === 0 && text) {
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

  log(
    "agent",
    `[${chatId}] -> (${durationMs}ms, in=${inputTokens} out=${outputTokens}` +
      `${toolCalls > 0 ? ` tools=${toolCalls}` : ""})`,
  );
  traceMessage(chatId, "out", allResponseText, {
    durationMs,
    inputTokens,
    outputTokens,
    toolCalls,
    model: activeModel,
  });

  return {
    text: allResponseText.trim(),
    durationMs,
    inputTokens,
    outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
  };
}
