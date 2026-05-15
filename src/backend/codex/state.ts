/**
 * Per-process state for the Codex backend.
 *
 * Unlike Kilo/OpenCode (one long-running HTTP server), Codex creates a
 * fresh subprocess on each `thread.run()` call via the SDK. The
 * per-process state Talon owns is therefore narrow: the long-lived
 * `Codex` instance (configured with API key + MCP server config) and
 * the config / frontend / gateway-port bindings.
 */

import type { Codex } from "@openai/codex-sdk";
import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../registry.js";

/** Singleton state container for the Codex backend. */
export interface CodexState {
  config: TalonConfig | null;
  codex: Codex | null;
  gatewayPortFn: () => number;
  frontendName: FrontendName;
}

const state: CodexState = {
  config: null,
  codex: null,
  gatewayPortFn: () => 19876,
  frontendName: "telegram",
};

/** Test-only accessor for the shared state object. */
export function getState(): CodexState {
  return state;
}

/** Reset all state — test isolation helper. */
export function resetState(): void {
  state.config = null;
  state.codex = null;
  state.gatewayPortFn = () => 19876;
  state.frontendName = "telegram";
}
