/**
 * Per-process state for the Antigravity backend.
 *
 * The bridge subprocess is keyed on chat id (one persistent bridge per
 * active chat). When a chat switches MCP server config (Talon's
 * frontend-tools server is chat-scoped), the bridge for that chat
 * needs to be torn down and replaced.
 */

import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../registry.js";
import type { AntigravityBridge } from "./python-bridge.js";

export interface AntigravityState {
  config: TalonConfig | null;
  /** Bridge subprocesses keyed by chat id. */
  bridges: Map<string, AntigravityBridge>;
  gatewayPortFn: () => number;
  frontendName: FrontendName;
}

const state: AntigravityState = {
  config: null,
  bridges: new Map(),
  gatewayPortFn: () => 19876,
  frontendName: "telegram",
};

export function getState(): AntigravityState {
  return state;
}

/** Reset state — test isolation. Best-effort cleanup of running bridges. */
export async function resetState(): Promise<void> {
  const oldBridges = Array.from(state.bridges.values());
  state.config = null;
  state.bridges = new Map();
  state.gatewayPortFn = () => 19876;
  state.frontendName = "telegram";
  await Promise.allSettled(oldBridges.map((b) => b.shutdown()));
}
