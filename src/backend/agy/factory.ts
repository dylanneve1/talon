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
import {
  handleMessage as agyHandleMessage,
  resetChat as agyResetChat,
} from "./handler.js";
import * as agyModels from "./models.js";
import { AGY_DEFAULT_BINARY, AGY_LABEL } from "./constants.js";
import { setAgyMcpContext } from "./factory-context.js";
import { uninstallMcpConfig } from "./mcp-config.js";
import type { TalonConfig } from "../../util/config.js";

function activeFrontends(
  frontend: TalonConfig["frontend"],
): readonly string[] {
  // MCP servers are spawned per-frontend; the terminal frontend has no
  // tool surface, so it never gets an entry. Matches the antigravity
  // backend's `getActiveFrontends` helper.
  const all = Array.isArray(frontend) ? frontend : [frontend];
  return all.filter((f) => f !== "terminal");
}

const agyFactory: BackendFactory = {
  id: "agy",
  label: AGY_LABEL,

  async init(config, ctx) {
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

    // Stash the context the handler needs at turn time — gateway port
    // (late-bound), active frontends, and the brave key — so each turn
    // can re-stamp `~/.gemini/config/mcp_config.json` with the right
    // `TALON_CHAT_ID` env before spawning agy. See `mcp-config.ts` for
    // the merge / `__talon__`-marker scheme.
    const cfgRecord = config as unknown as Record<string, unknown>;
    const braveApiKey =
      typeof cfgRecord.braveApiKey === "string"
        ? (cfgRecord.braveApiKey as string)
        : undefined;
    setAgyMcpContext({
      getBridgePort: ctx.getBridgePort,
      frontends: activeFrontends(config.frontend),
      braveApiKey,
    });

    const backend: QueryBackend = {
      query: agyHandleMessage,
      // `/reset` calls this — drops the per-chat agy conversation id
      // so the next turn starts a fresh agy conversation.
      resetChat: agyResetChat,
      // Model surface — minimal, single-entry catalogue.
      listModels: agyModels.listModels,
      resolveModel: agyModels.resolveModel,
      getModelInfo: agyModels.getModelInfo,
      getProviders: agyModels.getProviders,
      getProviderModels: agyModels.getProviderModels,
      formatModelError: agyModels.formatModelError,
      getSettingsPresentation: agyModels.getSettingsPresentation,
      backendLabel: AGY_LABEL,
    };

    return {
      backend,
      // On shutdown / pool eviction, strip Talon's MCP entries from
      // agy's config so the user's interactive agy sessions don't see
      // dead `__talon__` server references. Non-Talon entries the user
      // added by hand are preserved (see `stripTalonEntries`).
      cleanup: async () => {
        uninstallMcpConfig();
      },
    };
  },
};

registerBackend(agyFactory);
