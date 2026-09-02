/**
 * Bind one remote-server backend from its profile.
 *
 * Kilo is a fork of OpenCode and exposes the same HTTP API, so everything
 * a backend in this family does — spawn or reuse the local server,
 * register the chat and plugin MCP servers, create sessions, resolve a
 * model's provider — is shared code acting on a per-backend
 * `RemoteServerState`. What actually differs between the two backends is
 * the handful of fields on `RemoteBackendProfile`: the SDK's client and
 * server constructors, the loopback port, the delivery contract, and how
 * a stored model string splits into provider/model ids.
 *
 * Before this module each backend carried its own ~300-line `server.ts`
 * of hand-written pass-through wrappers around the shared helpers. They
 * drifted in the small ways copies do (one documented the port override,
 * the other didn't; one exported `errMsg`, the other aliased it) while
 * doing exactly the same thing. Now a backend's `server.ts` declares its
 * profile and re-exports these bindings under the historical names —
 * the surface the models module, the tests, and
 * `vi.mock("../backend/<name>/server.js")` all address.
 */

import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";
import {
  buildDeliveryContract,
  type DeliveryMode,
} from "../shared/delivery-contract.js";
import type { RemoteAgentClient } from "./client.js";
import { createRemoteServerState, errMsg } from "./state.js";
import { ensureRemoteServer, stopRemoteServer } from "./lifecycle.js";
import {
  ensureChatMcpServer as ensureChatMcpServerShared,
  ensurePluginMcpServers as ensurePluginMcpServersShared,
  buildToolOverrides as buildToolOverridesShared,
  disconnectChatMcpServer as disconnectChatMcpServerShared,
  refreshPluginMcpServers as refreshPluginMcpServersShared,
  getRegisteredMcpServerNames as getRegisteredMcpServerNamesShared,
} from "./mcp.js";
import { ensureRemoteSession, warmRemoteSession } from "./sessions.js";
import { resolveProviderID as resolveProviderIDShared } from "./providers.js";
import { guessProviderID, getBucketPriority } from "./model-catalog/index.js";

/** Every backend in the family binds to loopback — never exposed externally. */
const LOOPBACK_HOSTNAME = "127.0.0.1";

/** A stored model value split into the ids the server's prompt API wants. */
export interface RemoteModelSelection {
  providerID?: string;
  modelID: string;
}

/** The per-backend seams. Everything else in the family is shared. */
export interface RemoteBackendProfile<TClient extends RemoteAgentClient> {
  /** Display label for log lines and error text ("Kilo", "OpenCode"). */
  label: string;
  /** Loopback port the local server listens on by default. */
  defaultPort: number;
  /**
   * Env var that overrides the port, so integration tests can spawn an
   * isolated server alongside a running production Talon that holds the
   * default.
   */
  portEnv: string;
  /** Delivery contract the system-prompt suffix carries. */
  deliveryContract: DeliveryMode;
  /** Strict SDK client over an already-running server URL. */
  createClient(baseUrl: string): TClient;
  /** Spawn a fresh local server; `close()` runs from `stop()`. */
  createServer(args: {
    hostname: string;
    port: number;
    timeout: number;
  }): Promise<{ url: string; close(): void }>;
  /** Split a stored model-selection string into provider/model ids. */
  parseModelSelection(value: string): RemoteModelSelection;
}

/** The bound backend: the shared helpers closed over this backend's state. */
export interface RemoteServerBindings<TClient extends RemoteAgentClient> {
  /** `http://127.0.0.1:<port>` — where the local server is expected. */
  readonly baseUrl: string;
  /** Delivery-contract suffix for a given frontend's tool names. */
  systemPromptSuffix(frontend: string): string;
  /** Telegram-shaped suffix, kept for one-shot (cross-surface) paths. */
  readonly defaultSystemPromptSuffix: string;
  /**
   * Store the config, gateway-port resolver, and frontend label. Does
   * NOT spawn the server — that happens lazily on the first
   * `ensureServer()` so heartbeat-only installs don't pay for it.
   */
  init(
    cfg: TalonConfig,
    getGatewayPort?: () => number,
    frontend?: FrontendName,
  ): void;
  /**
   * Register a callback to run whenever the server is stopped. Cache
   * invalidation lives with the caches: the models module registers its
   * clear here at load time, so the server never imports it (a cycle).
   */
  onServerStop(hook: () => void): void;
  /**
   * Stop the local server if we own it and clear caches. Idempotent; a
   * reused pre-existing server is left running.
   */
  stop(): void;
  /** Lazily start (or reuse) the local server and return a strict client. */
  ensureServer(): Promise<TClient>;
  ensureChatMcpServer(oc: TClient, chatId: string): Promise<string>;
  ensurePluginMcpServers(oc: TClient, chatId: string): Promise<string[]>;
  /**
   * A `tools` override map enabling ONLY this chat's Talon tools. Session
   * permission rules cover execution; this covers visibility, because the
   * server exposes every registered MCP server's tools to every session.
   */
  buildToolOverrides(
    oc: TClient,
    chatServerName: string,
    pluginServerNames?: readonly string[],
  ): Promise<Record<string, boolean> | undefined>;
  disconnectChatMcpServer(oc: TClient, serverName: string): Promise<void>;
  refreshPluginMcpServers(chatId: string): Promise<{
    added: string[];
    removed: string[];
    errors: Record<string, string>;
  }>;
  updateSystemPrompt(prompt: string): void;
  /**
   * Resume the stored session id if the server confirms it is alive;
   * otherwise create a fresh one with Talon's standard permission ruleset.
   */
  ensureSession(oc: TClient, chatId: string): Promise<string>;
  /** Front-load a chat's cold start after `/reset`. Never throws. */
  warmSession(chatId: string): Promise<void>;
  /** Resolve a model id to its provider id against the live catalog. */
  resolveProviderID(oc: TClient, modelID: string): Promise<string>;
  parseModelSelection(value: string): RemoteModelSelection;
  /** Throws if `init` has not run. */
  getConfig(): TalonConfig;
  /**
   * Locally-cached MCP registrations. Test-only: `GET /mcp` returns `{}`
   * regardless of state on both servers.
   */
  getRegisteredMcpServerNames(): string[];
  errMsg(e: unknown): string;
}

export function bindRemoteServer<TClient extends RemoteAgentClient>(
  profile: RemoteBackendProfile<TClient>,
): RemoteServerBindings<TClient> {
  const port = Number(process.env[profile.portEnv] ?? profile.defaultPort);
  const state = createRemoteServerState<TClient>({
    label: profile.label,
    hostname: LOOPBACK_HOSTNAME,
    port,
  });
  const stopHooks = new Set<() => void>();

  const systemPromptSuffix = (frontend: string): string =>
    `\n\n${buildDeliveryContract(profile.deliveryContract, frontend)}\n`;

  const ensureServer = (): Promise<TClient> =>
    ensureRemoteServer({
      state,
      createClient: profile.createClient,
      createServer: profile.createServer,
    });
  const ensureSession = (oc: TClient, chatId: string): Promise<string> =>
    ensureRemoteSession(oc, state, chatId);
  const ensureChatMcpServer = (oc: TClient, chatId: string): Promise<string> =>
    ensureChatMcpServerShared(oc, state, chatId);
  const ensurePluginMcpServers = (
    oc: TClient,
    chatId: string,
  ): Promise<string[]> => ensurePluginMcpServersShared(oc, state, chatId);

  return {
    baseUrl: state.baseUrl,
    systemPromptSuffix,
    defaultSystemPromptSuffix: systemPromptSuffix("telegram"),
    init(cfg, getGatewayPort, frontend) {
      state.config = cfg;
      if (getGatewayPort) state.gatewayPortFn = getGatewayPort;
      if (frontend) state.frontendName = frontend;
    },
    onServerStop(hook) {
      stopHooks.add(hook);
    },
    stop() {
      stopRemoteServer(state, () => {
        for (const hook of stopHooks) hook();
      });
    },
    ensureServer,
    ensureChatMcpServer,
    ensurePluginMcpServers,
    buildToolOverrides: (oc, chatServerName, pluginServerNames = []) =>
      buildToolOverridesShared(oc, state, chatServerName, pluginServerNames),
    disconnectChatMcpServer: (oc, serverName) =>
      disconnectChatMcpServerShared(oc, state, serverName),
    refreshPluginMcpServers: async (chatId) =>
      refreshPluginMcpServersShared(await ensureServer(), state, chatId),
    updateSystemPrompt(prompt) {
      if (state.config) state.config.systemPrompt = prompt;
    },
    ensureSession,
    warmSession: (chatId) =>
      warmRemoteSession(state, chatId, {
        ensureServer,
        ensureSession,
        ensureChatMcpServer,
        ensurePluginMcpServers,
      }),
    resolveProviderID: (oc, modelID) =>
      resolveProviderIDShared(oc, state, modelID, {
        guessProviderID,
        getBucketPriority,
      }),
    parseModelSelection: profile.parseModelSelection,
    getConfig() {
      if (!state.config) {
        throw new Error(
          `${profile.label} agent not initialized — call init${profile.label}Agent first`,
        );
      }
      return state.config;
    },
    getRegisteredMcpServerNames: () => getRegisteredMcpServerNamesShared(state),
    errMsg,
  };
}
