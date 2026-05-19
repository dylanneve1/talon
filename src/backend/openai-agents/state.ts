/**
 * Per-process state for the OpenAI Agents backend.
 *
 * The Agents SDK is stateless from Talon's perspective — there's no
 * long-running server. The state we own here is the saved config +
 * gateway-port resolver + frontend label captured at init time, plus
 * the endpoint-model catalog populated by discovery (`discovery.ts`)
 * so the resolver, picker, and UIs can read it synchronously.
 */

import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../registry.js";

/**
 * Capabilities advertised by the remote endpoint for one model id.
 * Populated lazily by `startDiscovery()` after `init.ts` kicks off
 * `GET /models`, then consulted by the passthrough-model code path in
 * `models.ts`. An empty `EndpointModelCapabilities` ({}) means "the
 * endpoint mentioned this id but advertised no metadata" — callers
 * should treat that as a known passthrough.
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
  /** Resolved endpoint baseURL the SDK is currently aimed at (or undefined for the OpenAI default). */
  baseURL: string | undefined;
  /** Resolved API key the SDK is currently using (or undefined for unauthenticated). */
  apiKey: string | undefined;
  /**
   * Endpoint-advertised model metadata, keyed by model id. Populated
   * asynchronously after `init()` so /status, /settings, and the model
   * picker can show real context windows for OpenRouter / Ollama /
   * LiteLLM / vLLM / any other OpenAI-compatible endpoint that
   * implements `GET /models`.
   */
  endpointModels: Map<string, EndpointModelCapabilities>;
  /**
   * In-flight discovery promise, if any. The picker awaits this with
   * a short timeout on first render after a backend switch so the
   * catalog isn't empty just because the HTTP fetch hasn't returned.
   * Cleared once the fetch settles (success or failure).
   */
  discoveryPromise: Promise<void> | null;
  /** Wall-clock time (`Date.now()`) when discovery last succeeded, or `null`. */
  discoveryAt: number | null;
}

const state: OpenAIAgentsState = {
  config: null,
  gatewayPortFn: () => 19876,
  frontendName: "telegram",
  baseURL: undefined,
  apiKey: undefined,
  endpointModels: new Map(),
  discoveryPromise: null,
  discoveryAt: null,
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
  state.baseURL = undefined;
  state.apiKey = undefined;
  state.endpointModels.clear();
  state.discoveryPromise = null;
  state.discoveryAt = null;
}
