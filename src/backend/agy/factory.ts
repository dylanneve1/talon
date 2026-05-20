/**
 * Agy backend factory.
 *
 * Registers a thin wrapper around the local `agy` CLI binary
 * (~/.local/bin/agy). Auth is whatever's persisted in
 * `~/.gemini/antigravity-cli/` — there's no `init` work to do
 * beyond confirming the binary exists.
 *
 * Caveats (deliberate — see handler.ts for the rationale):
 *
 *   - **No tool calls.** `agy --print` doesn't surface MCP tool calls
 *     through stdout in a structured way, and wiring agy's MCP
 *     config (~/.gemini/config/mcp_config.json) would clobber the
 *     user's regular agy setup. Tool-calling is a future task.
 *   - **No model selection per chat.** agy uses whatever model the
 *     last interactive session selected; we don't override it.
 *   - **No heartbeat/dream wiring.** Without `runOneShotAgent`, the
 *     heartbeat agent falls back to whichever backend `heartbeatBackend`
 *     selects (usually claude).
 *
 * If/when MCP integration arrives, this factory will grow a
 * `refreshMcpServers` hook + `runOneShotAgent` (mirroring claude-sdk's
 * factory shape).
 */

import { spawnSync } from "node:child_process";
import { registerBackend } from "../registry.js";
import type { BackendFactory } from "../registry.js";
import type { QueryBackend } from "../../core/types.js";
import { log, logWarn } from "../../util/log.js";
import { handleMessage as agyHandleMessage } from "./handler.js";
import * as agyModels from "./models.js";
import { AGY_DEFAULT_BINARY, AGY_LABEL } from "./constants.js";

const agyFactory: BackendFactory = {
  id: "agy",
  label: AGY_LABEL,

  async init(_config, _ctx) {
    // Sanity check: does `agy` exist on PATH? Don't refuse to register
    // if it's missing — the user might install it later, and other
    // backends in the pool should still come up — but emit a warning
    // so the failure mode is obvious if a chat ever routes here.
    const which = spawnSync("which", [AGY_DEFAULT_BINARY], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const binaryPath = which.stdout?.toString().trim();
    if (which.status === 0 && binaryPath) {
      log("agent", `agy backend ready (binary=${binaryPath})`);
    } else {
      logWarn(
        "agent",
        `agy backend registered but '${AGY_DEFAULT_BINARY}' not on PATH — ` +
          `queries to this backend will fail until you install it. ` +
          `See https://github.com/google-antigravity/`,
      );
    }

    const backend: QueryBackend = {
      query: agyHandleMessage,
      // Model surface — minimal, single-entry catalogue.
      listModels: agyModels.listModels,
      resolveModel: agyModels.resolveModel,
      getModelInfo: agyModels.getModelInfo,
      getProviders: agyModels.getProviders,
      getProviderModels: agyModels.getProviderModels,
      formatModelError: agyModels.formatModelError,
      getSettingsPresentation: agyModels.getSettingsPresentation,
    };

    return { backend };
  },
};

registerBackend(agyFactory);
