/**
 * Helper to bridge the gap between MCP server *registration* and *connection*.
 *
 * `Query.setMcpServers` resolves as soon as servers are registered — MCP
 * startup is non-blocking by design. A stdio server that dials a slow remote
 * endpoint (e.g. the playwright plugin connecting to the Camoufox websocket)
 * finishes its `initialize` handshake seconds later. During that window the
 * server is reported as `pending` and its tools are absent from the live
 * registry, so a turn that proceeds immediately after `refreshTools` sees
 * `mcp__playwright-tools__*` stuck "connecting" until the next refresh.
 *
 * `waitForMcpServersReady` polls `mcpServerStatus()` until the named servers
 * leave the transient `pending` state (or a bounded timeout elapses), so the
 * caller can return only once the freshly-added tools are actually usable.
 */

import type { Query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Resolve once every server in `names` has left the `pending` state, or after
 * `timeoutMs`. Best-effort and non-throwing: any error from `mcpServerStatus()`
 * ends the wait so the turn is never blocked. Servers that settle into a
 * terminal state (`connected`/`failed`/`needs-auth`/`disabled`) also resolve
 * the wait — only the transient `pending` window is blocked on.
 */
export async function waitForMcpServersReady(
  qi: Pick<Query, "mcpServerStatus">,
  names: string[],
  timeoutMs = 60_000,
  pollMs = 250,
): Promise<void> {
  if (names.length === 0) return;
  const pending = new Set(names);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let statuses;
    try {
      statuses = await qi.mcpServerStatus();
    } catch {
      return; // status query unsupported/failed — don't block the turn
    }
    for (const s of statuses) {
      if (pending.has(s.name) && s.status !== "pending") {
        pending.delete(s.name);
      }
    }
    if (pending.size === 0) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
