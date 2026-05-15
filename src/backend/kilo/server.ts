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
  type PermissionRule,
} from "@kilocode/sdk/v2";
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

/**
 * Names of MCP servers we have already registered with the Kilo HTTP server
 * during this Talon process. Kilo's `GET /mcp` (what `oc.mcp.status()` hits)
 * empirically always returns `{}` regardless of the actual state, so we can't
 * rely on the server to tell us what's already registered — we cache it
 * locally instead. Cleared on `stopKiloServer` so a fresh process starts
 * over.
 *
 * Kilo's POST /mcp is idempotent (a second `add` for an existing name
 * returns the current state without re-spawning the subprocess), so the
 * worst case of a stale cache is one wasted POST, not a crash. The benefit
 * is large: skipping ~16 redundant POSTs per turn cuts ~12s off every
 * Kilo turn's setup phase.
 */
const registeredMcpServers = new Set<string>();

// ── Constants ───────────────────────────────────────────────────────────────

/** Loopback hostname Talon binds the Kilo server on — never exposed externally. */
export const KILO_HOSTNAME = "127.0.0.1";
/** Default TCP port for the local Kilo server. Overridable via `KILO_PORT`
 *  env var so integration tests can spawn an isolated Kilo server alongside
 *  a running production Talon (which holds the default 4097). */
export const KILO_PORT = Number(process.env.KILO_PORT ?? 4097);
/** Convenience URL composed from KILO_HOSTNAME + KILO_PORT. */
export const KILO_BASE_URL = `http://${KILO_HOSTNAME}:${KILO_PORT}`;
/** MCP server name prefix used to namespace Talon's per-chat MCP registrations. */
export const TALON_MCP_SERVER_NAME = "talon-tools";

/**
 * MCP add() calls slower than this get a `[slow]` annotation in the log
 * so operators can spot misbehaving plugins or a sluggish Kilo server.
 * Picked as a soft threshold — most local subprocess spawns finish in
 * <500ms; the outliers are the ones worth investigating.
 */
const SLOW_MCP_REGISTRATION_MS = 1000;

/**
 * System-prompt suffix appended to the user-configured system prompt.
 *
 * Kilo delivery model: the model's reply reaches the user via either
 *
 *   1. A `type: "text"` part — what most Kilo-routed models emit by
 *      default (DeepSeek, GLM, openrouter routes). Talon walks the
 *      `parts` list at end of turn and ships text-part content via
 *      `onTextBlock`. Reasoning parts are dropped as scratchpad.
 *
 *   2. A delivery tool — `end_turn` / `send` / `react`. The tool itself
 *      bridges to Telegram, so it's the right path when you need
 *      reply-to targeting, buttons, photos, polls, etc.
 *
 * Both routes work; pick whichever fits the message. The suffix below
 * keeps it short — the tool descriptions themselves carry the detail.
 */
export const KILO_SYSTEM_PROMPT_SUFFIX = `

## Kilo Delivery

Two ways to deliver a reply — pick whichever fits:

- **Plain text** — your assistant text is the reply. Just answer
  normally. (Reasoning content stays private.)
- **Delivery tools** — call \`end_turn(text="...", reply_to=N)\` for
  threaded replies, \`send(type="text"|"photo"|"poll"|...)\` for rich
  content, or \`react(emoji="...")\` for emoji acknowledgements. Use
  these when you need reply targeting, buttons, attachments, or
  multiple bubbles.

If you call a delivery tool, don't also repeat the same text in plain
output — Talon dedupes but it's cleaner to commit to one route.
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

  // Pre-warm plugin MCP servers in the background so the first chat
  // message doesn't pay the ~12s subprocess-spawn cost. We don't pre-warm
  // chat-namespaced servers (those depend on chatId, not known yet); the
  // first turn for any chat still incurs ~800ms for that one server, but
  // the dominant cost (16+ plugin servers in series) is amortised away.
  // Errors are swallowed — pre-warm is best-effort, the per-turn ensure
  // still runs and would log any real failures.
  prewarmPluginMcpServers().catch((err) => {
    logWarn("agent", `Plugin MCP pre-warm failed (non-fatal): ${errMsg(err)}`);
  });
}

/**
 * Background pre-warm of plugin MCP servers. Connects each
 * plugin-provided MCP server to the Kilo HTTP server eagerly so the
 * first turn doesn't spend 12+ seconds spawning subprocesses in
 * series. Per-chat MCP servers can't be pre-warmed (they're
 * chat-namespaced) but those are spawned once per process and cached.
 */
async function prewarmPluginMcpServers(): Promise<void> {
  // Defer until the Kilo server is alive — `ensureServer()` will lazy-spawn
  // it on the first call. We deliberately don't await here on the fast
  // path; the catch in initKiloAgent handles any spawn failures.
  const oc = await ensureServer();
  // Use a sentinel chat id for the pre-warm so plugin MCP servers don't
  // bind their bridge calls to a real chat — those calls would fail the
  // gateway's active-context check anyway. Plugin tools that genuinely
  // need a chat context get re-bound when a real chat starts.
  await ensurePluginMcpServers(oc, "prewarm");
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
  registeredMcpServers.clear();
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
    const spawnStartedAt = Date.now();

    try {
      const server = await createKiloServer({
        hostname: KILO_HOSTNAME,
        port: KILO_PORT,
        timeout: 10_000,
      });
      client = createStrictKiloClient(server.url);
      serverHandle = server;
      log(
        "agent",
        `Kilo server running at ${server.url} (spawned in ${Date.now() - spawnStartedAt}ms)`,
      );
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

  // Disconnect any OTHER chat's MCP server first. Kilo exposes every
  // registered MCP server's tools to every session — and per-session
  // permission rules only block *execution*, not *visibility*. So if
  // both `talon-tools-A` and `talon-tools-B` are connected, the model
  // in chat A can still see `talon-tools-B_send` in its tool catalog
  // and try to call it (observed in prod: model in group calling
  // `talon-tools-352042062_react`, hitting either a deny or a
  // wrong-chat bridge route). Holding only one chat-namespaced server
  // connected at a time is the only way to actually hide cross-chat
  // tools from the model. Plugin servers (extras-tools, github-tools,
  // ...) and the heartbeat sentinel server stay connected; only chat
  // servers get rotated out.
  for (const other of [...registeredMcpServers]) {
    if (
      !other.startsWith(`${TALON_MCP_SERVER_NAME}-`) ||
      other === serverName
    ) {
      continue;
    }
    if (other === `${TALON_MCP_SERVER_NAME}-heartbeat`) continue;
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

  // Local cache short-circuit. Kilo's GET /mcp returns {} regardless of
  // actual state, so we trust our own record of what we registered
  // earlier in this process — see the registeredMcpServers comment.
  if (registeredMcpServers.has(serverName)) {
    return serverName;
  }

  const startedAt = Date.now();
  try {
    const toolsPath = new URL("../../core/tools/mcp-server.ts", import.meta.url)
      .pathname;
    await oc.mcp.add({
      name: serverName,
      config: {
        type: "local",
        // Run the MCP server under Talon's launcher supervisor so the
        // child dies cleanly when the SDK pipe closes OR Talon's bridge
        // URL stops responding (catches the kilo-outlives-Talon case).
        command: wrapMcpCommand(["node", "--import", "tsx", toolsPath]),
        environment: {
          TALON_BRIDGE_URL: `http://127.0.0.1:${gatewayPortFn()}`,
          TALON_CHAT_ID: chatId,
          TALON_FRONTEND: frontendName,
        },
      },
    });
    registeredMcpServers.add(serverName);
    const ms = Date.now() - startedAt;
    log(
      "agent",
      `Registered ${serverName} MCP server with Kilo (${ms}ms)` +
        (ms > SLOW_MCP_REGISTRATION_MS ? " [slow]" : ""),
    );
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

  // Local cache short-circuit. Kilo's GET /mcp returns {} regardless of
  // actual state, so the previous "ask the server what's connected"
  // version always re-registered all 16 plugin servers per turn (~12s of
  // wasted setup). We track our own registrations now and only POST when
  // we haven't seen this server name before in this process.
  for (const [name, cfg] of Object.entries(pluginServers)) {
    if (registeredMcpServers.has(name)) {
      registered.push(name);
      continue;
    }
    try {
      const startedAt = Date.now();
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
      const ms = Date.now() - startedAt;
      log(
        "agent",
        `Registered plugin MCP server: ${name} (${ms}ms)` +
          (ms > SLOW_MCP_REGISTRATION_MS ? " [slow]" : ""),
      );
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
    // Drop from the local cache so a future ensureChatMcpServer call
    // re-registers (otherwise the cache would short-circuit and we'd
    // happily skip a server Kilo no longer has).
    registeredMcpServers.delete(serverName);
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

  // Per-session permission rules. Two jobs:
  //
  //   1. Hide other chats' MCP tools from this session. Kilo exposes
  //      every registered MCP server's tools to every session by default,
  //      so a model in chat A would happily call
  //      `talon-tools-<chatB>_send`. The bridge then routes to chat B,
  //      which fails the gateway's active-context check and returns
  //      "No active chat context". Or, in the cross-chat case where
  //      chat B IS active, the model in chat A could leak content into
  //      chat B. Deny pattern blocks both.
  //
  //   2. Auto-allow Kilo's built-in tools (read / bash / glob / ...) so
  //      they don't sit in `permission.asked` waiting for a reply that
  //      never arrives — Talon's question watchdog only handles
  //      `question.*` events, not `permission.*`. Without an allow
  //      rule the model's first `read` call hung the entire turn.
  //
  // Rules are evaluated in order; first match wins. (See Kilo's
  // `PermissionRule` type — `permission` is the rule category, `pattern`
  // is a glob.)
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
    `[${chatId}] Created Kilo session: ${newId} (scoped to ${ourServerName}_*)`,
  );

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
 * (e.g. `inclusionai/ling-2.6-1t:free`, `deepseek/deepseek-v4-flash:free`).
 * A naive `provider/model` splitter mis-treats those vendor prefixes as
 * the provider, so we generally return the whole string as the model id
 * and let `resolveProviderID` look up the real provider from the live
 * catalog.
 *
 * Exception: if the value starts with the literal `kilo/` prefix
 * (Talon's old hint that "this is a kilo-routed model"), strip it AND
 * pin providerID to `"kilo"`. Otherwise the upstream Kilo router gets
 * `kilo/deepseek/deepseek-v4-flash:free` as the model id and concats
 * its own provider in front, producing
 * `Model not found: opencode/kilo/deepseek/deepseek-v4-flash:free`.
 */
export function parseStoredKiloModelSelection(value: string): {
  providerID?: string;
  modelID: string;
} {
  const trimmed = value.trim();
  if (trimmed.startsWith("kilo/")) {
    return {
      providerID: "kilo",
      modelID: trimmed.slice("kilo/".length),
    };
  }
  return {
    providerID: undefined,
    modelID: trimmed,
  };
}

/** @deprecated Use {@link parseStoredKiloModelSelection} — alias for back-compat. */
export const parseStoredOpenCodeModelSelection = parseStoredKiloModelSelection;

// ── Internal accessors ─────────────────────────────────────────────────────

export function getConfig(): TalonConfig {
  return config;
}

/**
 * Snapshot of the locally-cached MCP server registrations. Test-only:
 * the `registeredMcpServers` Set is module-private state that integration
 * tests need to inspect to assert chat-switch isolation actually fired
 * (Kilo's GET /mcp returns {} regardless of state, so we can't query the
 * server itself). Don't rely on this in production code.
 */
export function getRegisteredMcpServerNames(): string[] {
  return [...registeredMcpServers];
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
