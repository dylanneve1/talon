/**
 * Per-process state for the OpenAI Agents backend.
 *
 * The Agents SDK is stateless from Talon's perspective — there's no
 * long-running server. The state we own here is the saved config +
 * gateway-port resolver + frontend label captured at init time, so
 * the per-turn handler can construct MCP servers + agents lazily.
 */

import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../registry.js";

/** Singleton state container for the backend. */
export interface OpenAIAgentsState {
  config: TalonConfig | null;
  gatewayPortFn: () => number;
  frontendName: FrontendName;
}

const state: OpenAIAgentsState = {
  config: null,
  gatewayPortFn: () => 19876,
  frontendName: "telegram",
};

/** Test-only accessor for the shared state object. */
export function getState(): OpenAIAgentsState {
  return state;
}

/** Reset all state — test isolation helper. */
export function resetState(): void {
  state.config = null;
  state.gatewayPortFn = () => 19876;
  state.frontendName = "telegram";
}
