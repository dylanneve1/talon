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
import { TalonSession } from "./session.js";

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
  /**
   * Per-chat conversation memory. The Agents SDK manages the full
   * turn history (model outputs, tool calls, tool results, reasoning)
   * when we pass a `TalonSession` into `run()`, so we just hand it
   * the same instance every turn for the same chat. `/reset` calls
   * `clearSession()` on the entry; chat eviction is bounded by the
   * map cap so long-lived bots don't leak memory.
   */
  sessions: Map<string, TalonSession>;
}

const state: OpenAIAgentsState = {
  config: null,
  gatewayPortFn: () => 19876,
  frontendName: "telegram",
  endpointModels: new Map(),
  sessions: new Map(),
};

const MAX_SESSIONS = 1000;

/**
 * Get or lazily create the `TalonSession` for a chat. Sessions
 * persist for the lifetime of the bot process; the LRU-style cap
 * keeps memory bounded if a long-running bot accumulates many chats.
 */
export function getOrCreateSession(chatId: string): TalonSession {
  const existing = state.sessions.get(chatId);
  if (existing) {
    // Refresh insertion-order so cap eviction is least-recently-used.
    state.sessions.delete(chatId);
    state.sessions.set(chatId, existing);
    return existing;
  }
  if (state.sessions.size >= MAX_SESSIONS) {
    const oldest = state.sessions.keys().next().value;
    if (oldest !== undefined) state.sessions.delete(oldest);
  }
  const session = new TalonSession({ sessionId: chatId });
  state.sessions.set(chatId, session);
  return session;
}

/**
 * Drop a chat's conversation memory. Called from the dispatcher's
 * reset path so `/reset` produces a clean turn-zero session.
 */
export function clearChatSession(chatId: string): void {
  state.sessions.delete(chatId);
}

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
  state.sessions.clear();
}
