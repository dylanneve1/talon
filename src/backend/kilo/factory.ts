/**
 * Kilo backend factory — wires Kilo into the registry.
 *
 * Side-effect import (`import "./factory.js"` from `bootstrap.ts`) calls
 * `registerBackend(...)` at module load, making Kilo available under
 * `config.backend === "kilo"`. The capability wiring is the shared
 * remote-server composition; only the bound functions are Kilo's.
 */

import { registerBackend } from "../../core/agent-runtime/backend-registry.js";
import { createRemoteBackendFactory } from "../remote-server/factory.js";
import {
  initKiloAgent,
  stopKiloServer,
  handleMessage,
  runOneShotAgent,
  getKiloSessionSnapshot,
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
    id: "kilo",
    label: "Kilo",
    sdkPackage: "@kilocode/sdk",
    init: initKiloAgent,
    stop: stopKiloServer,
    handleMessage,
    runOneShotAgent,
    getSessionSnapshot: getKiloSessionSnapshot,
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
