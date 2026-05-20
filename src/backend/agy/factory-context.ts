/**
 * Tiny module-level state for the agy backend — captures the bits of
 * `BackendInitContext` + config the handler needs at turn time
 * (gateway port, active frontends, brave key). Mirrors the pattern
 * the antigravity backend uses in its `state.ts`.
 */

import { logWarn } from "../../util/log.js";

interface AgyMcpContext {
  getBridgePort: () => number;
  frontends: readonly string[];
  braveApiKey?: string;
}

let ctx: AgyMcpContext | null = null;

export function setAgyMcpContext(next: AgyMcpContext): void {
  ctx = next;
}

export function getAgyMcpContext(): AgyMcpContext | null {
  if (!ctx) {
    logWarn(
      "agent",
      "agy: factory context not initialised — MCP install will be skipped",
    );
  }
  return ctx;
}
