/**
 * Kilo server lifecycle — manages the Kilo HTTP server process, MCP server
 * registration, session management, and provider resolution.
 *
 * Kilo (https://kilo.ai) is a fork of OpenCode that ships its own
 * `kilo serve` HTTP daemon. Talon spawns one local Kilo server per process
 * and talks to it over `@kilocode/sdk`'s v2 client.
 *
 * This module owns the long-lived `KiloClient` reference, the local
 * server handle, and the per-chat MCP registration / tool-override
 * machinery. The handler, sessions, and one-shot modules all consume the
 * helpers exported here rather than constructing their own clients.
 */

import {
  createKiloClient,
  createKiloServer,
  type KiloClient,
} from "@kilocode/sdk/v2";
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

// ── Module state ────────────────────────────────────────────────────────────

let config: TalonConfig;
let client: KiloClient | null = null;
let clientPromise: Promise<KiloClient> | null = null;
let serverHandle: { url: string; close(): void } | null = null;
let gatewayPortFn: () => number = () => 19876;
let frontendName: "telegram" | "terminal" | "teams" | "discord" = "telegram";

/** Lookup table that caches the resolved provider id for each model id we've
 * already seen. Cleared on `stopKiloServer` so a restarted backend resolves
 * against the fresh provider catalog. */
const modelProviderCache = new Map<string, string>();

// ── Constants ───────────────────────────────────────────────────────────────

/** Loopback hostname Talon binds the Kilo server on — never exposed externally. */
export const KILO_HOSTNAME = "127.0.0.1";
/** Default TCP port for the local Kilo server. */
export const KILO_PORT = 4097;
/** Convenience URL composed from KILO_HOSTNAME + KILO_PORT. */
export const KILO_BASE_URL = `http://${KILO_HOSTNAME}:${KILO_PORT}`;
/** MCP server name prefix used to namespace Talon's per-chat MCP registrations. */
export const TALON_MCP_SERVER_NAME = "talon-tools";

/**
 * System-prompt suffix appended to the user-configured system prompt.
 *
 * Talon's Telegram frontend supports two delivery flows in parallel:
 *
 *   1. **Tool-driven delivery** (preferred — matches Claude SDK):
 *      Call `end_turn(text=...)` or `send(type="text", text=...)` to ship
 *      a final reply. This route preserves message-id targeting, button
 *      attachments, mid-turn `send` calls (photos, polls), and the
 *      scratchpad-by-contract that drops accidental prose silently.
 *
 *   2. **Text-as-reply fallback** (legacy OpenCode behaviour):
 *      Plain assistant text is delivered as a message at the end of the
 *      turn. Useful when the model is doing pure conversational replies
 *      and doesn't need rich-message control. The handler dedups against
 *      tool-emitted text so you can't accidentally double-send by using
 *      both paths.
 *
 * The suffix tells the model both routes work; the Talon delivery layer
 * sorts out the rest.
 */
export const KILO_SYSTEM_PROMPT_SUFFIX = `

## Kilo Delivery

You are running through Talon's Kilo backend (a fork of OpenCode).

Two ways to deliver a reply, pick whichever fits the message best:

1. **end_turn / send** (preferred) — call \`end_turn(text="...")\` for a
   final reply, \`send(type="text", text="...")\` for mid-turn rich
   messages (photos, polls, buttons), or \`react\` for one-shot emoji
   acknowledgements. These give you reply-id targeting, button support,
   and explicit "I am done" semantics.

2. **Plain assistant text** — anything you write outside of a tool call
   is delivered as a single Telegram message at end of turn. Use this for
   quick conversational replies that don't need rich features.

Pick one path per turn — the handler dedups identical text across both,
but it's cleaner to commit to a single delivery route per reply.
`;

// ── Backward-compat aliases ────────────────────────────────────────────────
//
// Existing code (bootstrap.ts, opencode test utilities, the kilo handler
// itself) imports the OPENCODE_-prefixed names. We keep those exported as
// aliases so the rename is a non-breaking change — callers can migrate to
// the KILO_ names at their leisure.

/** @deprecated Use {@link KILO_HOSTNAME} instead. */
export const OPENCODE_HOSTNAME = KILO_HOSTNAME;
/** @deprecated Use {@link KILO_PORT} instead. */
export const OPENCODE_PORT = KILO_PORT;
/** @deprecated Use {@link KILO_BASE_URL} instead. */
export const OPENCODE_BASE_URL = KILO_BASE_URL;
/** @deprecated Use {@link KILO_SYSTEM_PROMPT_SUFFIX} instead. */
export const OPENCODE_SYSTEM_PROMPT_SUFFIX = KILO_SYSTEM_PROMPT_SUFFIX;

// ── Local utility ───────────────────────────────────────────────────────────

export const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

function createStrictKiloClient(baseUrl: string): KiloClient {
  return createKiloClient({
    baseUrl,
    throwOnError: true,
  });
}

// ── Init / teardown ─────────────────────────────────────────────────────────

/**
 * Initialise the Kilo backend.
 *
 * Stores the config + gateway-port resolver + frontend label needed by
 * downstream helpers. Does NOT spawn the Kilo server — that happens
 * lazily on the first `ensureServer()` call (so empty / heartbeat-only
 * Talon installs don't pay the startup cost until they need it).
 */
export function initKiloAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: "telegram" | "terminal" | "teams" | "discord",
): void {
  config = cfg;
  if (getGatewayPort) gatewayPortFn = getGatewayPort;
  if (frontend) frontendName = frontend;
}

/** @deprecated Use {@link initKiloAgent} — kept for backward compatibility. */
export const initOpenCodeAgent = initKiloAgent;

/**
 * Stop the local Kilo server (if we own it) and clear caches.
 *
 * Idempotent: safe to call multiple times. If we reused a pre-existing
 * server (via `reuseExistingServer`), this leaves it running — we don't
 * own it.
 */
export function stopKiloServer(): void {
  clientPromise = null;
  modelProviderCache.clear();
  clearModelCatalogCache();
  if (serverHandle) {
    serverHandle.close();
    serverHandle = null;
    client = null;
    log("agent", "Kilo server stopped");
  }
}

/** @deprecated Use {@link stopKiloServer} — kept for backward compatibility. */
export const stopOpenCodeServer = stopKiloServer;

// ── Server lifecycle ────────────────────────────────────────────────────────

/**
 * Lazily start (or reuse) the local Kilo server and return a strict client.
 *
 * Reuse path: probes `${KILO_BASE_URL}/global/health` first. If a Kilo
 * server is already listening there (e.g. left over from a previous
 * Talon process, or co-tenant tooling on the same VPS), we wrap it
 * instead of spawning a duplicate.
 */
export async function ensureServer(): Promise<KiloClient> {
  if (client) return client;
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const existingClient = await reuseExistingServer();
    if (existingClient) {
      client = existingClient;
      return existingClient;
    }

    log("agent", "Starting Kilo server...");

    try {
      const server = await createKiloServer({
        hostname: KILO_HOSTNAME,
        port: KILO_PORT,
        timeout: 10_000,
      });
      client = createStrictKiloClient(server.url);
      serverHandle = server;
      log("agent", `Kilo server running at ${server.url}`);
    } catch (err) {
      const reusedClient = await reuseExistingServer();
      if (!reusedClient) throw err;

      client = reusedClient;
      logWarn(
        "agent",
        `Kilo server already became available at ${KILO_BASE_URL}; reusing it`,
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

async function reuseExistingServer(): Promise<KiloClient | null> {
  try {
    const response = await fetch(`${KILO_BASE_URL}/global/health`);
    if (!response.ok) return null;

    const existingClient = createStrictKiloClient(KILO_BASE_URL);
    log("agent", `Reusing Kilo server at ${KILO_BASE_URL}`);
    return existingClient;
  } catch {
    return null;
  }
}

// ── MCP server registration ─────────────────────────────────────────────────

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

/**
 * Ensure the per-chat Talon MCP server is registered with Kilo.
 *
 * Each chat gets its own namespaced MCP server (`talon-tools-<chatId>`)
 * so concurrent chats can't see each other's tool environment. Returns
 * the registered server name so callers can scope tool-override lookups
 * to this chat alone.
 *
 * Best-effort: a registration failure logs a warning but doesn't throw —
 * the conversation can still proceed without Talon-tool access.
 */
export async function ensureChatMcpServer(
  oc: KiloClient,
  chatId: string,
): Promise<string> {
  const serverName = getChatMcpServerName(chatId);

  try {
    const statusResp = await oc.mcp.status();
    const mcpServers =
      (statusResp.data as Record<string, { status?: string }> | undefined) ??
      {};
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
    log("agent", `Registered ${serverName} MCP server with Kilo`);
  } catch (err) {
    logWarn(
      "agent",
      `MCP registration failed for ${serverName} (tools may not be available): ${errMsg(err)}`,
    );
  }

  return serverName;
}

/**
 * Register all plugin-provided MCP servers with Kilo.
 *
 * Plugins (mempalace, brave-search, github, ...) expose MCP servers via
 * `getPluginMcpServers`. Each is registered under its plugin-provided
 * name so the model can see them in the tool catalog. Already-connected
 * servers are skipped to avoid duplicate-register errors.
 *
 * Returns the list of server names that ended up registered (either
 * freshly added or already connected).
 */
export async function ensurePluginMcpServers(
  oc: KiloClient,
  chatId: string,
): Promise<string[]> {
  const { getPluginMcpServers } = await import("../../core/plugin.js");
  const bridgeUrl = `http://127.0.0.1:${gatewayPortFn()}`;
  const pluginServers = getPluginMcpServers(bridgeUrl, chatId);
  const registered: string[] = [];

  // Check which are already connected
  let existingServers: Record<string, { status?: string }> = {};
  try {
    const statusResp = await oc.mcp.status();
    existingServers =
      (statusResp.data as Record<string, { status?: string }> | undefined) ??
      {};
  } catch {
    // status check failed — try to register anyway
  }

  for (const [name, cfg] of Object.entries(pluginServers)) {
    if (existingServers[name]?.status === "connected") {
      registered.push(name);
      continue;
    }
    try {
      await oc.mcp.add({
        name,
        config: {
          type: "local",
          command: [cfg.command, ...cfg.args],
          environment: cfg.env ?? {},
        },
      });
      registered.push(name);
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

/**
 * Build a `tools` override map that enables ONLY this chat's Talon tools.
 *
 * Kilo's tool environment is global by default — all registered MCP
 * server tools are visible to every session. That's the wrong default
 * for Talon: chat A's `send` tool would dispatch to chat A's frontend
 * even if chat B's session called it. We override per-prompt to keep
 * each session pinned to its own namespaced tools.
 *
 * Returns `undefined` when no chat-scoped tools matched (e.g. MCP
 * registration failed silently above) — caller should skip passing
 * the `tools` field in that case.
 */
export async function buildToolOverrides(
  oc: KiloClient,
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
      `Failed to build Kilo tool overrides for ${chatServerName}: ${errMsg(err)}`,
    );
    return undefined;
  }
}

/**
 * Disconnect a per-chat MCP server.
 *
 * Called in handler `finally` blocks to release the chat-namespaced MCP
 * subprocess once the turn ends. Errors are swallowed (the server may
 * already be gone if MCP itself crashed).
 */
export async function disconnectChatMcpServer(
  oc: KiloClient,
  serverName: string,
): Promise<void> {
  try {
    await oc.mcp.disconnect({ name: serverName });
  } catch (err) {
    logWarn("agent", `Failed to disconnect ${serverName}: ${errMsg(err)}`);
  }
}

// ── Session management ─────────────────────────────────────────────────────

/**
 * Ensure a Kilo session exists for this chat.
 *
 * Resumes the stored session id if it's still valid. If the stored id is
 * stale (404 from `session.get`), resets local state and creates a fresh
 * session, returning the new id.
 */
export async function ensureSession(
  oc: KiloClient,
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
  log("agent", `[${chatId}] Created Kilo session: ${newId}`);
  return newId;
}

// ── Provider resolution ────────────────────────────────────────────────────

/**
 * Resolve a model id to its provider id by querying Kilo's provider list.
 *
 * Kilo's prompt payload requires `model.providerID` — Talon stores the
 * model id alone (so the user can write `claude-opus-4.7` without
 * knowing which auth bucket Kilo serves it from). This helper walks
 * every provider bucket, finds buckets that advertise this model id,
 * and picks the best match using `BUCKET_PRIORITY` + a name-prefix
 * heuristic from `guessProviderID`.
 *
 * Falls back to `guessProviderID` if no provider bucket claims the
 * model — useful for hand-typed model ids that don't appear in the
 * catalog at all (provider will reject them, but with a clearer error).
 */
export async function resolveProviderID(
  oc: KiloClient,
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

/**
 * Parse the stored model-selection string into a `{providerID?, modelID}` pair.
 *
 * Kilo model ids frequently contain `/` and `:` inside the model.id itself
 * (e.g. `inclusionai/ling-2.6-1t:free`). A naive `provider/model` splitter
 * mis-treats the `inclusionai/` prefix as the provider, so we always
 * return the whole string as the model id and let `resolveProviderID`
 * look up the real provider from the live catalog.
 */
export function parseStoredKiloModelSelection(value: string): {
  providerID?: string;
  modelID: string;
} {
  return {
    providerID: undefined,
    modelID: value.trim(),
  };
}

/** @deprecated Use {@link parseStoredKiloModelSelection} — alias for back-compat. */
export const parseStoredOpenCodeModelSelection = parseStoredKiloModelSelection;

// ── Internal accessors ─────────────────────────────────────────────────────

export function getConfig(): TalonConfig {
  return config;
}

export function getGatewayPortFn(): () => number {
  return gatewayPortFn;
}

export function getFrontendName():
  | "telegram"
  | "terminal"
  | "teams"
  | "discord" {
  return frontendName;
}

// Re-export the model-helper imports for kilo-internal consumers
export {
  guessProviderID,
  getBucketPriority,
  normalizeModelLookup,
  parseOpenCodeModelQuery,
};
