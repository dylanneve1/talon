/**
 * Kilo server lifecycle — thin wrapper around `backend/remote-server/`.
 *
 * The MCP / session / provider plumbing is identical to OpenCode (Kilo
 * is a fork of OpenCode that exposes the same HTTP API), so this module
 * keeps only the Kilo-specific bits:
 *
 *   - Constants (port 4097, system-prompt suffix wording).
 *   - SDK-specific client factory (`createKiloClient` + `createKiloServer`).
 *   - Backend-specific model parser (the `kilo/` prefix hint).
 *   - Pre-warm hook that triggers immediately at init.
 *
 * The shared machinery (server spawn, MCP registration, session creation,
 * provider resolution) lives in `backend/remote-server/`. All the
 * existing exports from this module are preserved for back-compat with
 * the handler / tests / heartbeat code that already imports them.
 */

import {
  createKiloClient,
  createKiloServer,
  type KiloClient,
} from "@kilocode/sdk/v2";
import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";
import { logWarn } from "../../util/log.js";
import { buildDeliveryContract } from "../shared/delivery-contract.js";
import { clearModelCatalogCache } from "./models/index.js";
import {
  guessProviderID,
  getBucketPriority,
  normalizeModelLookup,
  parseOpenCodeModelQuery,
} from "./models/index.js";
import {
  createRemoteServerState,
  ensureRemoteServer as ensureRemoteServerShared,
  stopRemoteServer,
  ensureChatMcpServer as ensureChatMcpServerShared,
  ensurePluginMcpServers as ensurePluginMcpServersShared,
  buildToolOverrides as buildToolOverridesShared,
  disconnectChatMcpServer as disconnectChatMcpServerShared,
  ensureRemoteSession,
  resolveProviderID as resolveProviderIDShared,
  getRegisteredMcpServerNames as getRegisteredMcpServerNamesShared,
  errMsg as sharedErrMsg,
  TALON_MCP_SERVER_NAME as SHARED_TALON_MCP_SERVER_NAME,
  type RemoteServerState,
} from "../remote-server/index.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** Loopback hostname Talon binds the Kilo server on — never exposed externally. */
export const KILO_HOSTNAME = "127.0.0.1";
/** Default TCP port for the local Kilo server. Overridable via `KILO_PORT`
 *  env var so integration tests can spawn an isolated Kilo server alongside
 *  a running production Talon (which holds the default 4097). */
export const KILO_PORT = Number(process.env.KILO_PORT ?? 4097);
/** Convenience URL composed from KILO_HOSTNAME + KILO_PORT. */
export const KILO_BASE_URL = `http://${KILO_HOSTNAME}:${KILO_PORT}`;
/** Re-export of the chat MCP server name prefix shared across backends. */
export const TALON_MCP_SERVER_NAME = SHARED_TALON_MCP_SERVER_NAME;

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
 * Both routes work; pick whichever fits the message. The shared
 * text-or-tools contract (prompts/system/contract-text-or-tools.md)
 * documents the choice — the tool descriptions carry the detail.
 * Telegram-shaped tool names: this constant is static and the prior
 * hand-written text hardcoded the same names.
 */
export function kiloSystemPromptSuffix(frontend: string): string {
  return `\n\n${buildDeliveryContract("text-or-tools", frontend)}\n`;
}

/** Telegram-shaped default, kept for one-shot (cross-surface) paths. */
export const KILO_SYSTEM_PROMPT_SUFFIX = kiloSystemPromptSuffix("telegram");

// ── State ───────────────────────────────────────────────────────────────────

const state: RemoteServerState<KiloClient> =
  createRemoteServerState<KiloClient>({
    label: "Kilo",
    hostname: KILO_HOSTNAME,
    port: KILO_PORT,
  });

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
  frontend?: FrontendName,
): void {
  state.config = cfg;
  if (getGatewayPort) state.gatewayPortFn = getGatewayPort;
  if (frontend) state.frontendName = frontend;

  // Pre-warm plugin MCP servers in the background so the first chat
  // message doesn't pay the ~12s subprocess-spawn cost. We don't pre-warm
  // chat-namespaced servers (those depend on chatId, not known yet); the
  // first turn for any chat still incurs ~800ms for that one server, but
  // the dominant cost (16+ plugin servers in series) is amortised away.
  // Errors are swallowed — pre-warm is best-effort, the per-turn ensure
  // still runs and would log any real failures.
  prewarmPluginMcpServers().catch((err) => {
    logWarn(
      "agent",
      `Plugin MCP pre-warm failed (non-fatal): ${sharedErrMsg(err)}`,
    );
  });
}

/**
 * Background pre-warm of plugin MCP servers. Connects each
 * plugin-provided MCP server to the Kilo HTTP server eagerly so the
 * first turn doesn't spend 12+ seconds spawning subprocesses in
 * series.
 */
async function prewarmPluginMcpServers(): Promise<void> {
  const client = await ensureServer();
  // Sentinel chat id so plugin MCP servers don't bind their bridge calls
  // to a real chat (those calls would fail the gateway's active-context
  // check anyway). Plugin tools that need a real chat context get
  // re-bound when a chat actually starts.
  await ensurePluginMcpServers(client, "prewarm");
}

/**
 * Stop the local Kilo server (if we own it) and clear caches.
 *
 * Idempotent: safe to call multiple times. If we reused a pre-existing
 * server, this leaves it running — we don't own it.
 */
export function stopKiloServer(): void {
  stopRemoteServer(state, clearModelCatalogCache);
}

// ── Server lifecycle ────────────────────────────────────────────────────────

/**
 * Lazily start (or reuse) the local Kilo server and return a strict client.
 *
 * Delegates to the shared `ensureRemoteServer` helper which handles the
 * spawn-race, the reuse-existing-server probe (`/global/health`), and
 * the wrap-after-bind fallback.
 */
export function ensureServer(): Promise<KiloClient> {
  return ensureRemoteServerShared({
    state,
    createClient: createStrictKiloClient,
    createServer: ({ hostname, port, timeout }) =>
      createKiloServer({ hostname, port, timeout }),
  });
}

// ── MCP server registration ─────────────────────────────────────────────────

/**
 * Ensure the per-chat Talon MCP server is registered with Kilo. See
 * `backend/remote-server/mcp.ts` for the full rationale + visibility-model
 * explanation; this wrapper just passes the Kilo state through.
 */
export function ensureChatMcpServer(
  oc: KiloClient,
  chatId: string,
): Promise<string> {
  return ensureChatMcpServerShared(oc, state, chatId);
}

/** Register all plugin-provided MCP servers with Kilo. */
export function ensurePluginMcpServers(
  oc: KiloClient,
  chatId: string,
): Promise<string[]> {
  return ensurePluginMcpServersShared(oc, state, chatId);
}

/**
 * Build a `tools` override map that enables ONLY this chat's Talon tools.
 *
 * Kilo's session-level `permission` rules cover *execution* hiding; this
 * `tools` map covers *visibility* — necessary because Kilo exposes every
 * registered MCP server's tools to every session by default.
 */
export function buildToolOverrides(
  oc: KiloClient,
  chatServerName: string,
): Promise<Record<string, boolean> | undefined> {
  return buildToolOverridesShared(oc, state, chatServerName);
}

/** Disconnect a per-chat MCP server (explicit teardown for hot-swap paths). */
export function disconnectChatMcpServer(
  oc: KiloClient,
  serverName: string,
): Promise<void> {
  return disconnectChatMcpServerShared(oc, state, serverName);
}

// ── Session management ─────────────────────────────────────────────────────

/**
 * Ensure a Kilo session exists for this chat. Resumes the stored session
 * id if `session.get` confirms it's still alive; otherwise resets and
 * creates a fresh session with Talon's standard permission ruleset.
 */
export function ensureSession(oc: KiloClient, chatId: string): Promise<string> {
  return ensureRemoteSession(oc, state, chatId);
}

// ── Provider resolution ────────────────────────────────────────────────────

/**
 * Resolve a model id to its provider id by querying Kilo's provider list.
 * The Kilo-specific bucket-priority + name-prefix heuristic comes from
 * `./models.ts`.
 */
export function resolveProviderID(
  oc: KiloClient,
  modelID: string,
): Promise<string> {
  return resolveProviderIDShared(oc, state, modelID, {
    guessProviderID,
    getBucketPriority,
  });
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

// ── Internal accessors ─────────────────────────────────────────────────────

export function getConfig(): TalonConfig {
  if (!state.config) {
    throw new Error("Kilo agent not initialized — call initKiloAgent first");
  }
  return state.config;
}

/**
 * Snapshot of the locally-cached MCP server registrations. Test-only:
 * Kilo's `GET /mcp` returns `{}` regardless of state, so integration
 * tests need this to assert chat-switch isolation actually fired.
 */
export function getRegisteredMcpServerNames(): string[] {
  return getRegisteredMcpServerNamesShared(state);
}

export function getGatewayPortFn(): () => number {
  return state.gatewayPortFn;
}

export function getFrontendName(): FrontendName {
  return state.frontendName;
}

/** Common error→message helper, re-exported for legacy importers. */
export const errMsg = sharedErrMsg;

// Re-export the model-helper imports for kilo-internal consumers
export {
  guessProviderID,
  getBucketPriority,
  normalizeModelLookup,
  parseOpenCodeModelQuery,
};
