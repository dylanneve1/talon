/**
 * OpenCode server lifecycle — thin wrapper around `backend/remote-server/`.
 *
 * The MCP / session / provider plumbing is identical to Kilo (Kilo is a
 * fork of OpenCode that exposes the same HTTP API), so this module
 * keeps only the OpenCode-specific bits:
 *
 *   - Constants (port 4096, system-prompt suffix wording).
 *   - SDK-specific client factory (`createOpencodeClient` +
 *     `createOpencodeServer`).
 *   - Backend-specific model parser (the fuzzy `provider/model` splitter
 *     from `./models.ts`).
 *   - Pre-warm hook that triggers immediately at init.
 *
 * The shared machinery (server spawn, MCP registration, session creation,
 * provider resolution) lives in `backend/remote-server/`.
 */

import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";
import { buildDeliveryContract } from "../shared/delivery-contract.js";
import {
  guessProviderID,
  getBucketPriority,
  normalizeModelLookup,
  parseRemoteModelQuery as parseOpenCodeModelQuery,
} from "../remote-server/model-catalog/index.js";
import {
  createRemoteServerState,
  ensureRemoteServer as ensureRemoteServerShared,
  stopRemoteServer,
  ensureChatMcpServer as ensureChatMcpServerShared,
  ensurePluginMcpServers as ensurePluginMcpServersShared,
  buildToolOverrides as buildToolOverridesShared,
  disconnectChatMcpServer as disconnectChatMcpServerShared,
  refreshPluginMcpServers as refreshPluginMcpServersShared,
  ensureRemoteSession,
  warmRemoteSession,
  resolveProviderID as resolveProviderIDShared,
  getRegisteredMcpServerNames as getRegisteredMcpServerNamesShared,
  errMsg as sharedErrMsg,
  TALON_MCP_SERVER_NAME as SHARED_TALON_MCP_SERVER_NAME,
  type RemoteServerState,
} from "../remote-server/index.js";

// ── Constants ───────────────────────────────────────────────────────────────

const OPENCODE_HOSTNAME = "127.0.0.1";
// Overridable via `OPENCODE_PORT` env so integration tests can spawn an
// isolated server alongside a running production Talon (which holds 4096).
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4096);
const OPENCODE_BASE_URL = `http://${OPENCODE_HOSTNAME}:${OPENCODE_PORT}`;
const TALON_MCP_SERVER_NAME = SHARED_TALON_MCP_SERVER_NAME;
// Text-preferred delivery: plain assistant text is the reply; tools
// only for genuine side effects. Single-sourced from the shared
// contract templates (prompts/system/contract-text-preferred.md).
export function opencodeSystemPromptSuffix(frontend: string): string {
  return `\n\n${buildDeliveryContract("text-preferred", frontend)}\n`;
}

/** Telegram-shaped default, kept for one-shot (cross-surface) paths. */
const OPENCODE_SYSTEM_PROMPT_SUFFIX = opencodeSystemPromptSuffix("telegram");

// ── State ───────────────────────────────────────────────────────────────────

const state: RemoteServerState<OpencodeClient> =
  createRemoteServerState<OpencodeClient>({
    label: "OpenCode",
    hostname: OPENCODE_HOSTNAME,
    port: OPENCODE_PORT,
  });

function createStrictOpencodeClient(baseUrl: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl,
    throwOnError: true,
  });
}

// ── Init / teardown ─────────────────────────────────────────────────────────

export function initOpenCodeAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: FrontendName,
): void {
  state.config = cfg;
  if (getGatewayPort) state.gatewayPortFn = getGatewayPort;
  if (frontend) state.frontendName = frontend;
}

/**
 * Callbacks run when the server stops — cache invalidation lives with the
 * caches. The models module registers its clear here at load time, so the
 * server never has to import it (which would be a cycle).
 */
const stopHooks = new Set<() => void>();

/** Register a callback to run whenever the OpenCode server is stopped. */
export function onServerStop(hook: () => void): void {
  stopHooks.add(hook);
}

export function stopOpenCodeServer(): void {
  stopRemoteServer(state, () => {
    for (const hook of stopHooks) hook();
  });
}

// ── Server lifecycle ────────────────────────────────────────────────────────

export function ensureServer(): Promise<OpencodeClient> {
  return ensureRemoteServerShared({
    state,
    createClient: createStrictOpencodeClient,
    createServer: ({ hostname, port, timeout }) =>
      createOpencodeServer({ hostname, port, timeout }),
  });
}

// ── MCP server registration ─────────────────────────────────────────────────

export function ensureChatMcpServer(
  oc: OpencodeClient,
  chatId: string,
): Promise<string> {
  return ensureChatMcpServerShared(oc, state, chatId);
}

export function ensurePluginMcpServers(
  oc: OpencodeClient,
  chatId: string,
): Promise<string[]> {
  return ensurePluginMcpServersShared(oc, state, chatId);
}

export function buildToolOverrides(
  oc: OpencodeClient,
  chatServerName: string,
  pluginServerNames: readonly string[] = [],
): Promise<Record<string, boolean> | undefined> {
  return buildToolOverridesShared(oc, state, chatServerName, pluginServerNames);
}

export function disconnectChatMcpServer(
  oc: OpencodeClient,
  serverName: string,
): Promise<void> {
  return disconnectChatMcpServerShared(oc, state, serverName);
}

export async function refreshPluginMcpServers(chatId: string) {
  const oc = await ensureServer();
  return refreshPluginMcpServersShared(oc, state, chatId);
}

export function updateSystemPrompt(prompt: string): void {
  if (state.config) state.config.systemPrompt = prompt;
}

// ── Session management ─────────────────────────────────────────────────────

export function ensureSession(
  oc: OpencodeClient,
  chatId: string,
): Promise<string> {
  return ensureRemoteSession(oc, state, chatId);
}

/**
 * Front-load a chat's cold start after `/reset`. Mirrors the Claude
 * backend's `warmSession` so the `sessions` capability slot behaves the
 * same across backends. Never throws — see `warmRemoteSession`.
 */
export function warmSession(chatId: string): Promise<void> {
  return warmRemoteSession(state, chatId, {
    ensureServer,
    ensureSession,
    ensureChatMcpServer,
    ensurePluginMcpServers,
  });
}

// ── Provider resolution ────────────────────────────────────────────────────

export function resolveProviderID(
  oc: OpencodeClient,
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
 * OpenCode model ids occasionally encode the provider as a `provider/model`
 * prefix (e.g. `openrouter/anthropic/claude-3.5-sonnet`). The parser here
 * is fuzzy — it tries to extract a provider hint from the prefix while
 * preserving the full model id when ambiguous. See `./models.ts` for the
 * underlying `parseOpenCodeModelQuery` logic.
 */
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

// ── Internal accessors ─────────────────────────────────────────────────────

export function getConfig(): TalonConfig {
  if (!state.config) {
    throw new Error(
      "OpenCode agent not initialized — call initOpenCodeAgent first",
    );
  }
  return state.config;
}

/**
 * Snapshot of the locally-cached MCP server registrations. Test-only.
 */
export function getRegisteredMcpServerNames(): string[] {
  return getRegisteredMcpServerNamesShared(state);
}

const errMsg = sharedErrMsg;

export {
  OPENCODE_HOSTNAME,
  OPENCODE_PORT,
  OPENCODE_BASE_URL,
  TALON_MCP_SERVER_NAME,
  OPENCODE_SYSTEM_PROMPT_SUFFIX,
  errMsg,
};
