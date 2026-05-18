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

/**
 * Capabilities advertised by the remote endpoint for one model id.
 * Populated lazily by `fetchEndpointModels()` in `init.ts` after
 * startup, then consulted by the passthrough-model code path in
 * `models.ts`. `null` means the lookup hasn't happened yet (or
 * failed); callers should treat that as "no enrichment available"
 * and continue without crashing.
 */
export interface EndpointModelCapabilities {
  contextWindow?: number;
  displayName?: string;
  /** Whether the model is free (e.g. OpenRouter `pricing.prompt === "0"`). */
  free?: boolean;
}

/** Singleton state container for the backend. */
export interface OpenAIAgentsState {
  config: TalonConfig | null;
  gatewayPortFn: () => number;
  frontendName: FrontendName;
  /**
   * Endpoint-advertised model metadata, keyed by model id. Populated
   * asynchronously after `init()` so /status, /settings, and model
   * picker UIs can show real context windows for OpenRouter / Ollama
   * / LiteLLM / vLLM / any other OpenAI-compatible endpoint that
   * implements `GET /models`.
   */
  endpointModels: Map<string, EndpointModelCapabilities>;
}

const state: OpenAIAgentsState = {
  config: null,
  gatewayPortFn: () => 19876,
  frontendName: "telegram",
  endpointModels: new Map(),
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
  state.endpointModels.clear();
}
