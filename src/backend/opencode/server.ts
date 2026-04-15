/**
 * OpenCode server lifecycle — manages the OpenCode server process,
 * MCP server registration, session management, and provider resolution.
 *
 * Extracted from index.ts to keep the main module focused on query handling.
 */

import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type { TalonConfig } from "../../util/config.js";
import {
  getSession,
  resetSession,
  setSessionId,
} from "../../storage/sessions.js";
import { log, logWarn } from "../../util/log.js";
import { clearModelCatalogCache } from "./models.js";
import {
  guessProviderID,
  getBucketPriority,
  normalizeModelLookup,
  parseOpenCodeModelQuery,
} from "./models.js";

let config: TalonConfig;
let client: OpencodeClient | null = null;
let clientPromise: Promise<OpencodeClient> | null = null;
let serverHandle: { url: string; close(): void } | null = null;
let gatewayPortFn: () => number = () => 19876;
let frontendName: "telegram" | "terminal" | "teams" = "telegram";
const modelProviderCache = new Map<string, string>();

const OPENCODE_HOSTNAME = "127.0.0.1";
const OPENCODE_PORT = 4096;
const OPENCODE_BASE_URL = `http://${OPENCODE_HOSTNAME}:${OPENCODE_PORT}`;
const TALON_MCP_SERVER_NAME = "talon-tools";
const OPENCODE_SYSTEM_PROMPT_SUFFIX = `

## OpenCode Delivery Override

- You are running through Talon's OpenCode backend.
- Return your normal user-facing reply as plain assistant text.
- Do not rely on the Telegram send tool for ordinary replies.
- Use tools only when they are genuinely needed for side effects or extra capabilities.
`;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function createStrictOpencodeClient(baseUrl: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl,
    throwOnError: true,
  });
}

export function initOpenCodeAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: "telegram" | "terminal" | "teams",
): void {
  config = cfg;
  if (getGatewayPort) gatewayPortFn = getGatewayPort;
  if (frontend) frontendName = frontend;
}

export async function ensureServer(): Promise<OpencodeClient> {
  if (client) return client;
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const existingClient = await reuseExistingServer();
    if (existingClient) {
      client = existingClient;
      return existingClient;
    }

    log("agent", "Starting OpenCode server...");

    try {
      const server = await createOpencodeServer({
        hostname: OPENCODE_HOSTNAME,
        port: OPENCODE_PORT,
        timeout: 10_000,
      });
      client = createStrictOpencodeClient(server.url);
      serverHandle = server;
      log("agent", `OpenCode server running at ${server.url}`);
    } catch (err) {
      const reusedClient = await reuseExistingServer();
      if (!reusedClient) throw err;

      client = reusedClient;
      logWarn(
        "agent",
        `OpenCode server already became available at ${OPENCODE_BASE_URL}; reusing it`,
      );
    }

    return client;
  })();

  try {
    return await clientPromise;
  } finally {
    clientPromise = null;
  }
}

async function reuseExistingServer(): Promise<OpencodeClient | null> {
  try {
    const response = await fetch(`${OPENCODE_BASE_URL}/global/health`);
    if (!response.ok) return null;

    const existingClient = createStrictOpencodeClient(OPENCODE_BASE_URL);
    log("agent", `Reusing OpenCode server at ${OPENCODE_BASE_URL}`);
    return existingClient;
  } catch {
    return null;
  }
}

function getChatMcpServerName(chatId: string): string {
  const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]+/g, "_") || "chat";
  return `${TALON_MCP_SERVER_NAME}-${safeChatId}`;
}

function isTalonToolID(toolID: string): boolean {
  return (
    toolID.startsWith(`${TALON_MCP_SERVER_NAME}_`) ||
    toolID.startsWith(`${TALON_MCP_SERVER_NAME}-`)
  );
}

export async function ensureChatMcpServer(
  oc: OpencodeClient,
  chatId: string,
): Promise<string> {
  const serverName = getChatMcpServerName(chatId);

  try {
    const statusResp = await oc.mcp.status();
    const mcpServers =
      (statusResp.data as Record<string, { status?: string }> | undefined) ?? {};
    const talonTools = mcpServers[serverName];

    if (talonTools?.status === "connected") {
      return serverName;
    }

    const toolsPath = new URL("../../core/tools/mcp-server.ts", import.meta.url)
      .pathname;
    await oc.mcp.add({
      name: serverName,
      config: {
        type: "local",
        command: ["node", "--import", "tsx", toolsPath],
        environment: {
          TALON_BRIDGE_URL: `http://127.0.0.1:${gatewayPortFn()}`,
          TALON_CHAT_ID: chatId,
          TALON_FRONTEND: frontendName,
        },
      },
    });
    log("agent", `Registered ${serverName} MCP server with OpenCode`);
  } catch (err) {
    logWarn(
      "agent",
      `MCP registration failed for ${serverName} (tools may not be available): ${errMsg(err)}`,
    );
  }

  return serverName;
}

export async function buildToolOverrides(
  oc: OpencodeClient,
  chatServerName: string,
): Promise<Record<string, boolean> | undefined> {
  try {
    const toolIdsResp = await oc.tool.ids();
    const toolIds = Array.isArray(toolIdsResp.data) ? toolIdsResp.data : [];
    const overrides: Record<string, boolean> = {};
    const chatToolPrefix = `${chatServerName}_`;
    let matchedChatTool = false;

    for (const toolId of toolIds) {
      if (typeof toolId !== "string" || !isTalonToolID(toolId)) continue;

      const enabled = toolId.startsWith(chatToolPrefix);
      overrides[toolId] = enabled;
      matchedChatTool ||= enabled;
    }

    return matchedChatTool ? overrides : undefined;
  } catch (err) {
    logWarn(
      "agent",
      `Failed to build OpenCode tool overrides for ${chatServerName}: ${errMsg(err)}`,
    );
    return undefined;
  }
}

export async function disconnectChatMcpServer(
  oc: OpencodeClient,
  serverName: string,
): Promise<void> {
  try {
    await oc.mcp.disconnect({ name: serverName });
  } catch (err) {
    logWarn(
      "agent",
      `Failed to disconnect ${serverName}: ${errMsg(err)}`,
    );
  }
}

export function stopOpenCodeServer(): void {
  clientPromise = null;
  modelProviderCache.clear();
  clearModelCatalogCache();
  if (serverHandle) {
    serverHandle.close();
    serverHandle = null;
    client = null;
    log("agent", "OpenCode server stopped");
  }
}

export async function ensureSession(
  oc: OpencodeClient,
  chatId: string,
): Promise<string> {
  const session = getSession(chatId);

  if (session.sessionId) {
    try {
      await oc.session.get({ sessionID: session.sessionId });
      return session.sessionId;
    } catch {
      logWarn(
        "agent",
        `[${chatId}] Session ${session.sessionId} expired, creating new`,
      );
      resetSession(chatId);
    }
  }

  const resp = await oc.session.create({ title: `Chat ${chatId}` });
  const data = resp.data as Record<string, unknown> | undefined;
  const newId = (data?.id as string) ?? String(Date.now());
  setSessionId(chatId, newId);
  log("agent", `[${chatId}] Created OpenCode session: ${newId}`);
  return newId;
}

export async function resolveProviderID(
  oc: OpencodeClient,
  modelID: string,
): Promise<string> {
  const cachedProviderID = modelProviderCache.get(modelID);
  if (cachedProviderID) return cachedProviderID;

  const providerResp = await oc.provider.list();
  const providerBuckets =
    (providerResp.data as Record<string, unknown> | undefined) ?? {};
  const guessedProviderID = guessProviderID(modelID);
  const matches: Array<{ providerID: string; bucketName: string }> = [];

  for (const [bucketName, bucket] of Object.entries(providerBuckets)) {
    if (!Array.isArray(bucket)) continue;

    for (const provider of bucket) {
      if (!provider || typeof provider !== "object") continue;

      const providerData = provider as {
        id?: string;
        models?: Record<string, { providerID?: string }>;
      };

      const modelEntry = providerData.models?.[modelID];
      if (!modelEntry) continue;

      const providerID = modelEntry.providerID ?? providerData.id;
      if (!providerID) continue;

      matches.push({ providerID, bucketName });
    }
  }

  if (matches.length > 0) {
    const score = (m: (typeof matches)[0]) =>
      (m.providerID === guessedProviderID ? 0 : 2) +
      (m.providerID === "opencode" ? 0 : 1) +
      getBucketPriority(m.bucketName) * 0.1;
    matches.sort((a, b) => score(a) - score(b));

    const resolvedProviderID = matches[0].providerID;
    modelProviderCache.set(modelID, resolvedProviderID);
    return resolvedProviderID;
  }

  const fallbackProviderID = guessProviderID(modelID);
  modelProviderCache.set(modelID, fallbackProviderID);
  logWarn(
    "agent",
    `Could not resolve provider for model ${modelID}; falling back to ${fallbackProviderID}`,
  );
  return fallbackProviderID;
}

export function parseStoredOpenCodeModelSelection(
  value: string,
): { providerID?: string; modelID: string } {
  const { providerQuery, modelQuery } = parseOpenCodeModelQuery(value);
  return {
    providerID: providerQuery ? normalizeModelLookup(providerQuery) : undefined,
    modelID: modelQuery,
  };
}

export function getConfig(): TalonConfig {
  return config;
}

export {
  OPENCODE_HOSTNAME,
  OPENCODE_PORT,
  OPENCODE_BASE_URL,
  TALON_MCP_SERVER_NAME,
  OPENCODE_SYSTEM_PROMPT_SUFFIX,
  errMsg,
};
