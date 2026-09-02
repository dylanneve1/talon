/**
 * OpenCode backend factory — wires OpenCode into the registry.
 *
 * Side-effect import (`import "./factory.js"` from `bootstrap.ts`) calls
 * `registerBackend(...)` at module load, making OpenCode available under
 * `config.backend === "opencode"`. The capability wiring is the shared
 * remote-server composition; only the bound functions are OpenCode's.
 */

import { registerBackend } from "../../core/agent-runtime/backend-registry.js";
import { createRemoteBackendFactory } from "../remote-server/factory.js";
import {
  initOpenCodeAgent,
  stopOpenCodeServer,
  handleMessage,
  runOneShotAgent,
  getOpenCodeSessionSnapshot,
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
  refreshPluginMcpServers,
  updateSystemPrompt,
  warmSession,
} from "./index.js";

registerBackend(
  createRemoteBackendFactory({
    id: "opencode",
    label: "OpenCode",
    sdkPackage: "@opencode-ai/sdk",
    init: initOpenCodeAgent,
    stop: stopOpenCodeServer,
    handleMessage,
    runOneShotAgent,
    getSessionSnapshot: getOpenCodeSessionSnapshot,
    models: {
      resolveModel,
      getModelInfo,
      getSettingsPresentation,
      getProviders,
      getProviderModels,
      formatModelError,
      listModels,
    },
    refreshPluginMcpServers,
    warmSession,
    updateSystemPrompt,
  }),
);
