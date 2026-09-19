/**
 * Antigravity backend initialisation.
 *
 * Cheap and synchronous where it can be: capture config, the
 * gateway-port resolver and the owning frontend, then tidy the shared
 * MCP config file. Children spawn lazily on the first turn, and the
 * model catalog is probed in the background so `/model` is warm
 * without adding a spawn to startup.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";
import { log, logWarn } from "../../util/log.js";
import { getState } from "./state.js";
import { detectAgyAuth } from "./auth.js";
import { pruneForeignTalonEntries } from "./mcp/register.js";
import { refreshModels, resetModelCache } from "./models.js";

/** Initialise the backend. Safe to call again on a config reload. */
export function initAgyAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: FrontendName,
): void {
  const state = getState();
  state.config = cfg;
  if (getGatewayPort) state.gatewayPortFn = getGatewayPort;
  if (frontend) state.frontendName = frontend;
  state.systemPromptOverride = null;

  logAuth();
  // agy's MCP config file is shared and persistent; anything under the
  // Talon prefix that this boot did not write is a dead daemon's.
  pruneForeignTalonEntries();
  // Fire-and-forget: a cold `/model` would otherwise pay the spawn.
  resetModelCache();
  void refreshModels(true);
}

function logAuth(): void {
  const auth = detectAgyAuth();
  if (!auth.present) {
    logWarn(
      "agent",
      "Antigravity: no cached credentials at " +
        `${auth.path} — run \`agy\` once interactively on this host to sign in. ` +
        "There is no API key for this backend; headless runs reuse the OAuth cache.",
    );
    return;
  }
  if (auth.expired && !auth.refreshable) {
    logWarn(
      "agent",
      `Antigravity auth: token expired ${auth.expiry?.toISOString() ?? ""} ` +
        "with no refresh token — run `agy` again to re-authenticate.",
    );
    return;
  }
  log(
    "agent",
    `Antigravity auth: ${auth.method ?? "oauth"} credentials cached` +
      (auth.expiry ? ` (expiry ${auth.expiry.toISOString()})` : ""),
  );
}
