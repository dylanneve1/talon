/**
 * SDK options builder — constructs the configuration object for query() calls.
 *
 * Translates per-chat settings (model, effort) and global config (plugins,
 * MCP servers, system prompt) into the Options shape expected by the SDK.
 */

import { resolve } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { getSession } from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { getPluginMcpServers } from "../../core/plugin.js";
import { getConfig, getBridgePort } from "./state.js";
import { DISALLOWED_TOOLS_CHAT, EFFORT_MAP } from "./constants.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type BuildSdkOptionsResult = {
  options: Options;
  activeModel: string;
  session: ReturnType<typeof getSession>;
};

// ── MCP server construction ─────────────────────────────────────────────────

/**
 * Build the MCP servers map for a chat query.
 * Includes frontend-specific tool servers and Brave Search, if configured.
 */
function buildMcpServers(
  chatId: string,
): Record<
  string,
  { command: string; args: string[]; env: Record<string, string> }
> {
  const config = getConfig();
  const bridgeUrl = `http://127.0.0.1:${getBridgePort()}`;

  const tsxImport = resolve(
    import.meta.dirname ?? ".",
    "../../../node_modules/tsx/dist/esm/index.mjs",
  );
  const mcpServerPath = resolve(
    import.meta.dirname ?? ".",
    "../../core/tools/mcp-server.ts",
  );

  // Frontend-specific MCP tool servers (one per non-terminal frontend)
  const allFrontends = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  const frontends = allFrontends.filter((f) => f !== "terminal");

  const servers: Record<
    string,
    { command: string; args: string[]; env: Record<string, string> }
  > = {};

  for (const frontend of frontends) {
    const serverName = `${frontend}-tools`;
    const mcpEnv = {
      TALON_BRIDGE_URL: bridgeUrl,
      TALON_CHAT_ID: chatId,
      TALON_FRONTEND: frontend,
    };
    servers[serverName] = {
      command: process.platform === "win32" ? "npx" : "node",
      args:
        process.platform === "win32"
          ? ["tsx", mcpServerPath]
          : ["--import", tsxImport, mcpServerPath],
      env: mcpEnv,
    };
  }

  // Brave Search MCP server (if configured)
  if (config.braveApiKey) {
    servers["brave-search"] = {
      command: resolve(
        import.meta.dirname ?? ".",
        "../../../node_modules/.bin/brave-search-mcp-server",
      ),
      args: [],
      env: { BRAVE_API_KEY: config.braveApiKey },
    };
  }

  return servers;
}

// ── Options builder ─────────────────────────────────────────────────────────

export function buildSdkOptions(chatId: string): BuildSdkOptionsResult {
  const config = getConfig();
  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.model;
  const activeEffort = chatSettings.effort ?? "adaptive";

  const thinkingConfig = EFFORT_MAP[activeEffort] ?? {
    thinking: { type: "adaptive" as const },
  };

  const supports1m =
    !activeModel.includes("haiku") && !activeModel.includes("[1m]");
  const sdkModel = supports1m ? `${activeModel}[1m]` : activeModel;

  const session = getSession(chatId);

  const options: Options = {
    model: sdkModel,
    systemPrompt: config.systemPrompt,
    cwd: config.workspace,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(config.claudeBinary
      ? { pathToClaudeCodeExecutable: config.claudeBinary }
      : {}),
    disallowedTools: [...DISALLOWED_TOOLS_CHAT],
    ...thinkingConfig,
    mcpServers: {
      ...buildMcpServers(chatId),
      ...getPluginMcpServers(`http://127.0.0.1:${getBridgePort()}`, chatId),
    },
    ...(session.sessionId ? { resume: session.sessionId } : {}),
  };

  return { options, activeModel, session };
}
