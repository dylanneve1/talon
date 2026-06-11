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
import type { FrontendName } from "../registry.js";
import { logWarn } from "../../util/log.js";
import { buildDeliveryContract } from "../shared/delivery-contract.js";
import { clearModelCatalogCache } from "./models.js";
import {
  guessProviderID,
  getBucketPriority,
  normalizeModelLookup,
  parseOpenCodeModelQuery,
} from "./models.js";
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

const OPENCODE_HOSTNAME = "127.0.0.1";
// Overridable via `OPENCODE_PORT` env so integration tests can spawn an
// isolated server alongside a running production Talon (which holds 4096).
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4096);
const OPENCODE_BASE_URL = `http://${OPENCODE_HOSTNAME}:${OPENCODE_PORT}`;
const TALON_MCP_SERVER_NAME = SHARED_TALON_MCP_SERVER_NAME;
// Text-preferred delivery: plain assistant text is the reply; tools
// only for genuine side effects. Single-sourced from the shared
// contract templates (prompts/system/contract-text-preferred.md).
const OPENCODE_SYSTEM_PROMPT_SUFFIX = `\n\n${buildDeliveryContract(
  "text-preferred",
  "telegram",
)}\n`;

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

  // Pre-warm plugin MCP servers in the background. Same rationale as
  // the Kilo backend's init pre-warm.
  prewarmPluginMcpServers().catch((err) => {
    logWarn(
      "agent",
      `Plugin MCP pre-warm failed (non-fatal): ${sharedErrMsg(err)}`,
    );
  });
}

async function prewarmPluginMcpServers(): Promise<void> {
  const client = await ensureServer();
  await ensurePluginMcpServers(client, "prewarm");
}

export function stopOpenCodeServer(): void {
  stopRemoteServer(state, clearModelCatalogCache);
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
): Promise<Record<string, boolean> | undefined> {
  return buildToolOverridesShared(oc, state, chatServerName);
}

export function disconnectChatMcpServer(
  oc: OpencodeClient,
  serverName: string,
): Promise<void> {
  return disconnectChatMcpServerShared(oc, state, serverName);
}

// ── Session management ─────────────────────────────────────────────────────

export function ensureSession(
  oc: OpencodeClient,
  chatId: string,
): Promise<string> {
  return ensureRemoteSession(oc, state, chatId);
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
