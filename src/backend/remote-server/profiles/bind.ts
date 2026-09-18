/**
 * Bind one remote-server driver from a profile.
 *
 * Everything a member of this family does — spawn or reuse the local
 * server, register the chat and plugin MCP servers, create sessions,
 * fetch and render the model catalog, run a chat turn, run a one-shot
 * turn, read back a session snapshot — is shared code in
 * `backend/remote-server/`. What differs between OpenCode and its Kilo
 * fork is a short list of constants and two SDK constructors.
 *
 * `bindRemoteProfile` is where that list becomes a driver. It closes the
 * shared helpers over one profile's state and returns a single object
 * that is simultaneously:
 *
 *   - the {@link RemoteServerBindings} the shared turn paths need,
 *   - the bound model catalog + `Backend.models` adapter, and
 *   - a `RemoteBackendFactoryInputs`, ready for
 *     `createRemoteBackendFactory` in `backend/builtins.ts`.
 *
 * Before this module each backend carried a `server.ts`, `sessions.ts`,
 * `models/index.ts`, `model-provider.ts`, `handler/message.ts`,
 * `one-shot.ts`, `index.ts` and `factory.ts` whose entire content was
 * re-exporting these bindings under backend-prefixed names. Those 16
 * files are the profile objects in `./kilo.ts` and `./opencode.ts` now.
 */

import type { BackendId } from "../../../core/agent-runtime/model-ref.js";
import type { OneShotAgentParams, OneShotUsage } from "../../../core/types.js";
import type {
  QueryParams,
  QueryResult,
} from "../../runtime/turn/handler-types.js";
import type { DeliveryMode } from "../../runtime/prompt/delivery-contract.js";
import { runRemoteChatTurn } from "../chat-turn.js";
import type { RemoteAgentClient } from "../client.js";
import type { RemoteBackendFactoryInputs } from "../factory.js";
import {
  createRemoteModelCatalogModule,
  createRemoteModelProvider,
  formatRemoteUnavailableModel,
  getRemoteModelSelectionValue,
  resolveRemoteModelInput,
  type RemoteModelCatalogModule,
  type RemoteProviderClient,
} from "../model-catalog/index.js";
import {
  runRemoteOneShotAgent,
  type RemoteOneShotClient,
} from "../one-shot.js";
import {
  bindRemoteServer,
  type RemoteModelSelection,
  type RemoteServerBindings,
} from "../server-bindings.js";
import {
  getSessionSnapshot,
  type RemoteSessionClient,
} from "../session-helpers.js";

/**
 * The client shape a profile's SDK must satisfy: the shared helper
 * surface, the provider catalog, and the session lifecycle the one-shot
 * runner drives directly. Both `OpencodeClient` and `KiloClient` match
 * structurally.
 */
export type RemoteProfileClient = RemoteAgentClient &
  RemoteOneShotClient &
  RemoteProviderClient;

/** Everything that differs between two members of this family. */
export interface RemoteProfileDefinition<TClient extends RemoteProfileClient> {
  /** Registry id — matches `config.backend` ("kilo"). */
  id: BackendId;
  /** Display label for log lines, headers and error text ("Kilo"). */
  label: string;
  /** npm package of the SDK, for the startup log line. */
  sdkPackage: string;
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
  /**
   * Split a stored model-selection string into provider/model ids. The
   * one genuinely behavioural knob: the two upstream routers disagree
   * about what a `provider/model` prefix means.
   */
  parseModelSelection(value: string): RemoteModelSelection;
  /**
   * Model-picker budget, set by the surface the picker renders through.
   * Discord StringSelectMenu values hold 100 chars of anything; Telegram
   * `callback_data` holds 64 bytes and the keyboard is tight.
   */
  maxCallbackIdLength: number;
  allowCallbackSeparators: boolean;
  quickPickLimit: number;
}

/**
 * A bound driver: the server bindings, the catalog module, and the
 * registry factory inputs, in one object.
 */
export type RemoteProfile<TClient extends RemoteProfileClient> =
  RemoteServerBindings<TClient> &
    RemoteBackendFactoryInputs & {
      /** The bound catalog — cache, resolution, and picker rendering. */
      catalog: RemoteModelCatalogModule;
      /**
       * The knobs this driver was built from. Kept on the result so a
       * live-backend test can rebind the catalog to its own throwaway
       * server without restating the profile's picker budget.
       */
      definition: RemoteProfileDefinition<TClient>;
    };

export function bindRemoteProfile<TClient extends RemoteProfileClient>(
  definition: RemoteProfileDefinition<TClient>,
): RemoteProfile<TClient> {
  const { id, label, sdkPackage } = definition;

  const server = bindRemoteServer<TClient>({
    label,
    defaultPort: definition.defaultPort,
    portEnv: definition.portEnv,
    deliveryContract: definition.deliveryContract,
    createClient: definition.createClient,
    createServer: definition.createServer,
    parseModelSelection: definition.parseModelSelection,
  });

  const catalog = createRemoteModelCatalogModule({
    label,
    getClient: () => server.ensureServer(),
    maxCallbackIdLength: definition.maxCallbackIdLength,
    allowCallbackSeparators: definition.allowCallbackSeparators,
    quickPickLimit: definition.quickPickLimit,
  });
  // A stopped server invalidates the catalog it served.
  server.onServerStop(catalog.clearCache);

  const models = createRemoteModelProvider({
    label,
    getCatalog: (forceRefresh) => catalog.getCatalog(forceRefresh),
    getModelInfo: (modelId) => catalog.getModelInfo(modelId),
    resolveModelInput: (query, cat) => resolveRemoteModelInput(query, cat),
    getSelectionValue: (model, cat) => getRemoteModelSelectionValue(model, cat),
    formatUnavailableModel: (model) => formatRemoteUnavailableModel(model),
    getSettingsPresentation: (activeModel, pickerOptions) =>
      catalog.getSettingsPresentation(activeModel, pickerOptions),
  });

  const handleMessage = (params: QueryParams): Promise<QueryResult> =>
    runRemoteChatTurn(
      {
        id,
        label,
        getConfig: server.getConfig,
        ensureServer: server.ensureServer,
        trackActiveTurn: server.trackActiveTurn,
        parseModelSelection: server.parseModelSelection,
        resolveProviderID: server.resolveProviderID,
        ensureSession: server.ensureSession,
        ensureChatMcpServer: server.ensureChatMcpServer,
        ensurePluginMcpServers: server.ensurePluginMcpServers,
        buildToolOverrides: server.buildToolOverrides,
        systemPromptSuffix: server.systemPromptSuffix,
      },
      params,
    );

  const runOneShotAgent = (
    params: OneShotAgentParams,
  ): Promise<OneShotUsage | void> =>
    runRemoteOneShotAgent(
      {
        label,
        // The one-shot runner has no frontend in hand (heartbeat and
        // dream are cross-surface), so it carries the telegram-shaped
        // suffix — the same one the per-backend runners passed.
        systemPromptSuffix: server.defaultSystemPromptSuffix,
        ensureServer: server.ensureServer,
        parseModelSelection: server.parseModelSelection,
        resolveProviderID: server.resolveProviderID,
        ensureChatMcpServer: server.ensureChatMcpServer,
        ensurePluginMcpServers: server.ensurePluginMcpServers,
        buildToolOverrides: server.buildToolOverrides,
        disconnectChatMcpServer: server.disconnectChatMcpServer,
        errMsg: server.errMsg,
      },
      params,
    );

  return {
    ...server,
    id,
    label,
    sdkPackage,
    definition,
    catalog,
    models,
    handleMessage,
    runOneShotAgent,
    async getSessionSnapshot(sessionId) {
      if (!sessionId) return undefined;
      const oc = await server.ensureServer();
      return getSessionSnapshot(
        oc as unknown as RemoteSessionClient,
        sessionId,
      );
    },
  };
}
