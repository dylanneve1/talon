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
      resolveModel: (q) => Promise.resolve(resolveModel(q)),
      getModelInfo: (id) => Promise.resolve(getModelInfo(id)),
      getSettingsPresentation: (m, prefix) =>
        Promise.resolve(getSettingsPresentation(m, prefix)),
      getProviders: () => Promise.resolve(getProviders()),
      getProviderModels: (p, pg, ps) =>
        Promise.resolve(getProviderModels(p, pg, ps)),
      formatModelError: (q, r) => formatModelError(q, r),
      listModels: (f) => Promise.resolve(listModels(f)),
      runOneShotAgent: (p) => codexRunOneShotAgent(p),
      backendLabel: "Codex",
    };

    return { backend };
  },
};

registerBackend(codexFactory);
