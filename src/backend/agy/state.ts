/**
 * Per-process state for the Antigravity backend.
 *
 * Only the bindings captured at `init` (config, gateway-port resolver,
 * owning frontend) plus the per-chat usage the `/status` snapshot
 * reads. Two neighbours own the rest deliberately: `models.ts` holds
 * its own catalog cache (so the catalog can be read by `talon doctor`
 * without a live backend), and `process.ts` owns the per-chat children
 * (they have a spawn / idle-reap / kill lifecycle that does not belong
 * in a bag of fields).
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";

/** What `getSessionSnapshot` answers with, per chat. */
export interface AgySessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  contextModelId?: string;
}

export interface AgyState {
  config: TalonConfig | null;
  gatewayPortFn: () => number;
  frontendName: FrontendName;
  /**
   * System prompt for the next NEW conversation, when plugin
   * hot-reload pushed one through `control.updateSystemPrompt`.
   * Resumed conversations keep the prompt frozen into their history —
   * same semantics as codex.
   */
  systemPromptOverride: string | null;
  /** Last cumulative `result.usage` seen per chat. */
  lastUsage: Map<string, AgySessionUsage>;
}

const state: AgyState = {
  config: null,
  gatewayPortFn: () => 19876,
  frontendName: "telegram",
  systemPromptOverride: null,
  lastUsage: new Map<string, AgySessionUsage>(),
};

/** Accessor for the shared state object. */
export function getState(): AgyState {
  return state;
}

/** The daemon's loopback bridge URL, as the MCP hub serves it. */
export function bridgeUrl(): string {
  return `http://127.0.0.1:${state.gatewayPortFn()}`;
}

/**
 * Path to the `agy` executable: config `agyBinary`, else the
 * `AGY_BINARY` env var, else bare `agy` off PATH. Env wins over config
 * so a test harness can point at a stub without rewriting the
 * persisted config — the same precedence `codexBinary` uses.
 */
export function agyBinary(configBinary?: string): string {
  return (
    process.env.AGY_BINARY || configBinary || state.config?.agyBinary || "agy"
  );
}

/** Reset everything — test isolation helper and `cleanup` hook. */
export function resetState(): void {
  state.config = null;
  state.gatewayPortFn = () => 19876;
  state.frontendName = "telegram";
  state.systemPromptOverride = null;
  state.lastUsage.clear();
}
