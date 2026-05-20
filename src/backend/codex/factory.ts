/**
 * Codex backend factory — wires the OpenAI Codex SDK into the registry.
 *
 * The Codex backend spawns the `codex` CLI as a subprocess per turn
 * (via `@openai/codex-sdk`'s `thread.runStreamed`). MCP servers are
 * configured at thread-creation time via the CLI's `--config` TOML
 * overrides (see `mcp-config.ts`).
 */

import { registerBackend } from "../registry.js";
import type { BackendFactory } from "../registry.js";
import type { QueryBackend } from "../../core/types.js";
import { log } from "../../util/log.js";

import { initCodexAgent } from "./init.js";
import { handleMessage as codexHandleMessage } from "./handler.js";
import { runOneShotAgent as codexRunOneShotAgent } from "./one-shot.js";
import { resetState as resetCodexState } from "./state.js";
import {
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
} from "./models.js";

const codexFactory: BackendFactory = {
  id: "codex",
  label: "Codex",

  async init(config, ctx) {
    initCodexAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: Codex (@openai/codex-sdk)");

    const backend: QueryBackend = {
      query: (params) => codexHandleMessage(params),
      // Model methods are async in models.ts so they can await
      // `awaitDiscovery()` — the dynamic catalog from /v1/models needs
      // to be populated before resolve/getModelInfo/listModels return.
      resolveModel: (q) => resolveModel(q),
      getModelInfo: (id) => getModelInfo(id),
      getSettingsPresentation: (m, options) =>
        getSettingsPresentation(m, options),
      getProviders: () => getProviders(),
      getProviderModels: (p, pg, ps) => getProviderModels(p, pg, ps),
      formatModelError: (q, r) => formatModelError(q, r),
      listModels: (f) => listModels(f),
      runOneShotAgent: (p) => codexRunOneShotAgent(p),
      backendLabel: "Codex",
    };

    return {
      backend,
      // Cleanup: drop the cached Codex instance + state. The Codex
      // SDK's instances are stateless from our perspective (each
      // `runStreamed` spawns a fresh subprocess), so there's no
      // long-running server to stop — clearing module-scoped state
      // is enough for hot-reload + test isolation.
      cleanup: () => {
        resetCodexState();
        log("bot", "Codex backend cleaned up");
      },
    };
  },
};

registerBackend(codexFactory);
