/**
 * Per-process state for the Codex backend.
 *
 * Unlike Kilo/OpenCode (one long-running HTTP server), Codex creates a
 * fresh subprocess on each `thread.run()` call via the SDK. The
 * per-process state Talon owns is therefore narrow: the long-lived
 * `Codex` instance (configured with API key + MCP server config), the
 * config / frontend / gateway-port bindings, and the dynamic model
 * discovery cache.
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
  /**
   * Set of model ids OpenAI's `/v1/models` advertised for the current
   * api key. Empty when no key is configured or discovery hasn't yet
   * succeeded. Mutated only by `discovery.ts`.
   */
  discoveredModels: Set<string>;
  /**
   * In-flight discovery promise. Non-null while a fetch is pending;
   * cleared once the fetch settles (success or failure). Callers that
   * need a populated catalog `await awaitDiscovery()` against this.
   */
  discoveryPromise: Promise<void> | null;
  /**
   * Timestamp of the last discovery attempt (success OR failure).
   * Used to distinguish "still loading" from "finished, found nothing"
   * — the latter lets the picker fall back to curated immediately
   * instead of soft-waiting for a promise that already settled.
   */
  discoveryAt: number | null;
}

const state: CodexState = {
  config: null,
  codex: null,
  gatewayPortFn: () => 19876,
  frontendName: "telegram",
  discoveredModels: new Set<string>(),
  discoveryPromise: null,
  discoveryAt: null,
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
  state.discoveredModels.clear();
  state.discoveryPromise = null;
  state.discoveryAt = null;
}
