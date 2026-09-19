/**
 * Registration side of agy's MCP wiring: which scopes Talon currently
 * owns in the shared `mcp_config.json`, and the register / unregister
 * / prune operations the handler, the one-shot runner and the factory
 * drive.
 *
 * `mcp-config.ts` is the pure file layer (build, atomic write, remove,
 * snapshot cleanup). This module is the stateful half — it remembers
 * what this boot wrote so `pruneStaleTalonEntries` can tell our
 * entries from a dead daemon's leftovers.
 */

import { log, logWarn } from "../../util/log.js";
import { nonTerminalFrontends } from "../runtime/frontends.js";
import { getState, bridgeUrl } from "./state.js";
import {
  agyScopeSlug,
  buildAgyMcpServers,
  pruneStaleTalonEntries,
  removeAgyMcpServers,
  writeAgyMcpServers,
  type AgyMcpWriteOptions,
} from "./mcp-config.js";

/** Config keys this process wrote, by scope. */
const ownedKeys = new Map<string, string[]>();

/** Every key Talon currently owns, across all scopes. */
function ownedTalonKeys(): string[] {
  return [...ownedKeys.values()].flat();
}

/** Forget all ownership — test isolation. Does not touch the file. */
export function resetOwnership(): void {
  ownedKeys.clear();
}

/**
 * Write (or rewrite) the MCP entries for one scope.
 *
 * `chatId` drives which frontend tool servers are included; `scope`
 * defaults to that chat's slug but a one-shot passes its own so a
 * heartbeat's servers can be removed without disturbing a chat's.
 */
export function registerMcpForChat(
  chatId: string,
  options: AgyMcpWriteOptions & { scope?: string } = {},
): { scope: string; added: string[]; removed: string[]; keys: string[] } {
  const state = getState();
  const scope = options.scope ?? agyScopeSlug(chatId);
  const servers = buildAgyMcpServers({
    chatId,
    bridgeUrl: bridgeUrl(),
    frontends: nonTerminalFrontends(state.config?.frontend),
    braveApiKey: state.config?.braveApiKey,
    scope,
  });
  const keys = Object.keys(servers);
  const { added, removed } = writeAgyMcpServers(scope, servers, options);
  ownedKeys.set(scope, keys);
  if (added.length > 0 || removed.length > 0) {
    log(
      "agent",
      `[${chatId}] agy MCP entries: +${added.length} -${removed.length} (${keys.length} active)`,
    );
  }
  return { scope, added, removed, keys };
}

/** Drop one scope's entries and its schema snapshots. */
export function unregisterMcpScope(
  scope: string,
  options: AgyMcpWriteOptions = {},
): string[] {
  let removed: string[] = [];
  try {
    removed = removeAgyMcpServers(scope, options);
  } catch (err) {
    logWarn(
      "agent",
      `agy: failed to remove MCP scope ${scope}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  ownedKeys.delete(scope);
  return removed;
}

/** Drop the entries belonging to one chat. */
export function unregisterMcpForChat(
  chatId: string,
  options: AgyMcpWriteOptions = {},
): string[] {
  return unregisterMcpScope(agyScopeSlug(chatId), options);
}

/**
 * Remove every `__talon__*` entry this boot did not write.
 *
 * Called once from `init`. agy's config file is shared and persistent,
 * so a daemon that died without cleaning up — or, on this host, a
 * Talon backend deleted months earlier — leaves entries pointing at
 * hub URLs that nothing serves any more. agy then fails every tool
 * call against them with a transport error, which the model dutifully
 * reports to the user. Non-Talon entries are never touched.
 */
export function pruneForeignTalonEntries(
  options: AgyMcpWriteOptions = {},
): string[] {
  let stale: string[] = [];
  try {
    stale = pruneStaleTalonEntries(ownedTalonKeys(), options);
  } catch (err) {
    logWarn(
      "agent",
      `agy: MCP prune failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (stale.length > 0) {
    log("agent", `agy: pruned ${stale.length} stale Talon MCP entries`);
  }
  return stale;
}

/** Drop every scope this process owns — cleanup / shutdown. */
export function unregisterAllMcp(options: AgyMcpWriteOptions = {}): void {
  // Snapshot the scopes: unregisterMcpScope mutates the map as we go.
  const scopes = Object.keys(Object.fromEntries(ownedKeys));
  for (const scope of scopes) {
    unregisterMcpScope(scope, options);
  }
}
