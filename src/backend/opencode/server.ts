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
  type PermissionRule,
} from "@opencode-ai/sdk/v2";
import type { TalonConfig } from "../../util/config.js";
import {
  getSession,
  resetSession,
  setSessionId,
} from "../../storage/sessions.js";
import { log, logWarn } from "../../util/log.js";
import { wrapMcpCommand } from "../../util/mcp-launcher.js";
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
let frontendName: "telegram" | "terminal" | "teams" | "discord" = "telegram";
const modelProviderCache = new Map<string, string>();

/**
 * Names of MCP servers we have registered with the OpenCode HTTP server
 * during this Talon process. OpenCode's `GET /mcp` (what `oc.mcp.status()`
 * hits) empirically returns `{}` regardless of the actual state, so we
 * can't trust the server's view — we cache it locally instead. Cleared
 * on `stopOpenCodeServer` so a fresh process starts over.
 *
 * Mirrors the same machinery on the Kilo backend (see
 * `src/backend/kilo/server.ts`'s `registeredMcpServers`).
 */
const registeredMcpServers = new Set<string>();

const OPENCODE_HOSTNAME = "127.0.0.1";
// Overridable via `OPENCODE_PORT` env so integration tests can spawn an
// isolated server alongside a running production Talon (which holds 4096).
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4096);
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
  frontend?: "telegram" | "terminal" | "teams" | "discord",
): void {
  config = cfg;
  if (getGatewayPort) gatewayPortFn = getGatewayPort;
  if (frontend) frontendName = frontend;

  // Pre-warm plugin MCP servers in the background so the first chat
  // message doesn't pay the ~12s subprocess-spawn cost. See the
  // equivalent block in src/backend/kilo/server.ts for the rationale.
  prewarmPluginMcpServers().catch((err) => {
    logWarn("agent", `Plugin MCP pre-warm failed (non-fatal): ${errMsg(err)}`);
  });
}

async function prewarmPluginMcpServers(): Promise<void> {
  const oc = await ensureServer();
  await ensurePluginMcpServers(oc, "prewarm");
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

  // Disconnect every other chat-namespaced MCP server before connecting
  // ours. OpenCode (like Kilo) exposes every connected MCP server's
  // tools to every session — and per-session permission rules only
  // block *execution*, not *visibility*. With multiple chat servers
  // connected, a model in chat A could see and call
  // `talon-tools-<chatB>_send`. Holding only one chat-namespaced
  // server connected at a time is the only way to actually hide
  // cross-chat tools from the model.  Plugin servers and the heartbeat
  // sentinel server are exempt.
  for (const other of [...registeredMcpServers]) {
    if (
      !other.startsWith(`${TALON_MCP_SERVER_NAME}-`) ||
      other === serverName ||
      other === `${TALON_MCP_SERVER_NAME}-heartbeat`
    ) {
      continue;
    }
    try {
      await oc.mcp.disconnect({ name: other });
      registeredMcpServers.delete(other);
      log("agent", `Disconnected ${other} MCP server (chat switch)`);
    } catch (err) {
      logWarn(
        "agent",
        `Failed to disconnect ${other} during chat switch: ${errMsg(err)}`,
      );
    }
  }

  // Local cache short-circuit. OpenCode's GET /mcp returns {} regardless
  // of state, so we trust our own record of what we registered earlier
  // in this process.
  if (registeredMcpServers.has(serverName)) {
    return serverName;
  }

  try {
    const toolsPath = new URL("../../core/tools/mcp-server.ts", import.meta.url)
      .pathname;
    await oc.mcp.add({
      name: serverName,
      config: {
        type: "local",
        // Run under the launcher supervisor — see kilo/server.ts for
        // the lifecycle rationale (mirrors Claude SDK's wrapMcpServer).
        command: wrapMcpCommand(["node", "--import", "tsx", toolsPath]),
        environment: {
          TALON_BRIDGE_URL: `http://127.0.0.1:${gatewayPortFn()}`,
          TALON_CHAT_ID: chatId,
          TALON_FRONTEND: frontendName,
        },
      },
    });
    registeredMcpServers.add(serverName);
    log("agent", `Registered ${serverName} MCP server with OpenCode`);
  } catch (err) {
    logWarn(
      "agent",
      `MCP registration failed for ${serverName} (tools may not be available): ${errMsg(err)}`,
    );
  }

  return serverName;
}

export async function ensurePluginMcpServers(
  oc: OpencodeClient,
  chatId: string,
): Promise<string[]> {
  const { getPluginMcpServers } = await import("../../core/plugin.js");
  const bridgeUrl = `http://127.0.0.1:${gatewayPortFn()}`;
  const pluginServers = getPluginMcpServers(bridgeUrl, chatId);
  const registered: string[] = [];

  // Local cache short-circuit. OpenCode's GET /mcp returns {} regardless
  // of state, so the previous status-walking version of this function
  // re-registered all 16 plugin MCP servers per turn (~12s of wasted
  // setup per message). We track our own registrations now.
  for (const [name, cfg] of Object.entries(pluginServers)) {
    if (registeredMcpServers.has(name)) {
      registered.push(name);
      continue;
    }
    try {
      await oc.mcp.add({
        name,
        config: {
          type: "local",
          command: wrapMcpCommand([cfg.command, ...cfg.args]),
          environment: cfg.env ?? {},
        },
      });
      registered.push(name);
      registeredMcpServers.add(name);
      log("agent", `Registered plugin MCP server: ${name}`);
    } catch (err) {
      logWarn(
        "agent",
        `Plugin MCP registration failed for ${name}: ${errMsg(err)}`,
      );
    }
  }

  return registered;
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
    // Drop from the local cache so a future ensureChatMcpServer
    // re-registers (cache short-circuit otherwise skips a server
    // OpenCode no longer has).
    registeredMcpServers.delete(serverName);
  } catch (err) {
    logWarn("agent", `Failed to disconnect ${serverName}: ${errMsg(err)}`);
  }
}

export function stopOpenCodeServer(): void {
  clientPromise = null;
  modelProviderCache.clear();
  registeredMcpServers.clear();
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

  // Per-session permission ruleset. See the equivalent block in
  // src/backend/kilo/server.ts for the full rationale; in summary:
  //   1. Allow this chat's MCP tools (`talon-tools-<chatId>_*`).
  //   2. Deny every other chat's tools (defense in depth — the
  //      chat-switch disconnect above is the primary mechanism).
  //   3-5. Auto-allow Kilo/OpenCode built-ins (`tool *`, `edit *`,
  //      `bash *`) so they don't hang on `permission.asked` waiting
  //      for a watchdog reply Talon doesn't fire.
  const ourServerName = getChatMcpServerName(chatId);
  const permission: PermissionRule[] = [
    { permission: "tool", pattern: `${ourServerName}_*`, action: "allow" },
    {
      permission: "tool",
      pattern: `${TALON_MCP_SERVER_NAME}-*`,
      action: "deny",
    },
    { permission: "tool", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "allow" },
  ];

  const resp = await oc.session.create({
    title: `Chat ${chatId}`,
    permission,
  });
  const data = resp.data as Record<string, unknown> | undefined;
  const newId = (data?.id as string) ?? String(Date.now());
  setSessionId(chatId, newId);
  log(
    "agent",
    `[${chatId}] Created OpenCode session: ${newId} (scoped to ${ourServerName}_*)`,
  );
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

export function parseStoredOpenCodeModelSelection(value: string): {
  providerID?: string;
  modelID: string;
} {
  const { providerQuery, modelQuery } = parseOpenCodeModelQuery(value);
  return {
    providerID: providerQuery ? normalizeModelLookup(providerQuery) : undefined,
    modelID: modelQuery,
  };
}

export function getConfig(): TalonConfig {
  return config;
}

/**
 * Snapshot of the locally-cached MCP server registrations. Test-only
 * (mirrors the kilo backend's `getRegisteredMcpServerNames`). OpenCode's
 * `GET /mcp` returns `{}` regardless of state, so integration tests need
 * this to assert chat-switch isolation actually fired.
 */
export function getRegisteredMcpServerNames(): string[] {
  return [...registeredMcpServers];
}

export {
  OPENCODE_HOSTNAME,
  OPENCODE_PORT,
  OPENCODE_BASE_URL,
  TALON_MCP_SERVER_NAME,
  OPENCODE_SYSTEM_PROMPT_SUFFIX,
  errMsg,
};
