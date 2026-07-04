/**
 * Shared MCP-registration helpers for the remote-server backend family.
 *
 * Both OpenCode and Kilo expose the same MCP HTTP API surface
 * (`POST /mcp` to add, `DELETE /mcp/:name` to disconnect) and share the
 * same visibility model upstream: every registered MCP server's tools
 * are visible to every session by default. Per-session permission rules
 * only block *execution*, not *visibility* — which is why Talon has to
 * disconnect rival chat-namespaced MCP servers before connecting the
 * current one, instead of relying on permission rules alone.
 *
 * Functions exported here:
 *
 *   - {@link ensureChatMcpServer} — register the current chat's
 *     `talon-tools-<chatId>` MCP server, disconnecting any other chat's
 *     server in the process. Returns the registered name so callers can
 *     scope tool overrides to this chat alone.
 *   - {@link ensurePluginMcpServers} — bulk-register all plugin-provided
 *     MCP servers (`mempalace-tools`, `brave-search`, `github-tools`, …).
 *     These are shared globally (not chat-scoped) and only registered
 *     once per Talon process.
 *   - {@link buildToolOverrides} — produce a `tools` map that whitelists
 *     this chat's Talon tools and blacklists every other chat's. Used
 *     as the `tools` field on the prompt payload to constrain the model's
 *     visible tool catalog.
 *   - {@link disconnectChatMcpServer} — explicit teardown for hot-swap
 *     paths (plugin reload, shutdown).
 *
 * Performance: registrations are cached locally in
 * `state.registeredMcpServers`. Both OpenCode's and Kilo's `GET /mcp` is
 * known to return `{}` regardless of actual state, so we can't rely on
 * the server to tell us what's already registered. The local cache
 * skips ~16 redundant POSTs per turn (≈12s of wasted setup) for the
 * plugin servers, which spawn subprocesses on each `add`.
 */

import { log, logWarn } from "../../util/log.js";
import {
  talonHubUrl,
  pluginHubUrl,
  hubPluginServerNames,
} from "../../core/mcp-hub/index.js";
import type { RemoteAgentClient } from "./client.js";
import type { RemoteServerState } from "./state.js";
import { errMsg } from "./state.js";
import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";
import {
  frontendForChatId,
  nonTerminalFrontends,
} from "../shared/frontends.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** Stable name prefix for Talon's per-chat MCP servers. */
export const TALON_MCP_SERVER_NAME = "talon-tools";

/**
 * MCP add() calls slower than this get a `[slow]` annotation in the log
 * so operators can spot misbehaving plugins or a sluggish agent server.
 * Picked as a soft threshold — most local subprocess spawns finish in
 * <500ms; the outliers are the ones worth investigating.
 */
const SLOW_MCP_REGISTRATION_MS = 1000;

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Derive a chat MCP server name from a chat id. Telegram chat ids are
 * already alphanumeric/dash; Discord snowflakes are pure digits; the
 * sanitisation step is defense-in-depth for any future frontend.
 */
export function getChatMcpServerName(chatId: string): string {
  const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]+/g, "_") || "chat";
  return `${TALON_MCP_SERVER_NAME}-${safeChatId}`;
}

/** Whether a tool id belongs to one of Talon's MCP servers. */
export function isTalonToolID(toolID: string): boolean {
  return (
    toolID.startsWith(`${TALON_MCP_SERVER_NAME}_`) ||
    toolID.startsWith(`${TALON_MCP_SERVER_NAME}-`)
  );
}

/**
 * The frontend whose tool surface a chat should get: its owning
 * frontend (by chat-id shape) when that frontend is configured, else
 * the process-primary frontend — which also covers the heartbeat
 * sentinel and other cross-surface contexts.
 */
function resolveChatToolFrontend(
  state: { frontendName: FrontendName; config: TalonConfig | null },
  chatId: string,
): FrontendName {
  const owner = frontendForChatId(chatId);
  if (
    owner &&
    owner !== state.frontendName &&
    nonTerminalFrontends(state.config?.frontend).includes(owner)
  ) {
    return owner as FrontendName;
  }
  return state.frontendName;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Ensure the per-chat Talon MCP server is registered with the upstream
 * agent server.
 *
 * Each chat gets its own namespaced MCP server (`talon-tools-<chatId>`)
 * so concurrent chats can't see each other's tool environment. Before
 * connecting the current chat's server we DISCONNECT every other chat's
 * server (except the heartbeat sentinel) — this is the only way to hide
 * cross-chat tools from the model's visible catalog. The model's
 * permission rules deny EXECUTION of cross-chat tools but don't hide
 * them from visibility, so without the disconnect step the model in
 * chat A would see `talon-tools-<chatB>_send` in its tool catalog and
 * try to call it.
 *
 * Best-effort: a registration failure logs a warning but doesn't throw —
 * the conversation can still proceed without Talon-tool access.
 */
export async function ensureChatMcpServer<TClient extends RemoteAgentClient>(
  client: TClient,
  state: RemoteServerState<TClient>,
  chatId: string,
): Promise<string> {
  const serverName = getChatMcpServerName(chatId);

  // Rotate out other chat servers BEFORE registering this one. The
  // heartbeat sentinel server is exempt (it has no real chat to leak
  // into and stays connected for cron / trigger paths).
  for (const other of [...state.registeredMcpServers]) {
    if (
      !other.startsWith(`${TALON_MCP_SERVER_NAME}-`) ||
      other === serverName ||
      other === `${TALON_MCP_SERVER_NAME}-heartbeat`
    ) {
      continue;
    }
    try {
      await client.mcp.disconnect({ name: other });
      state.registeredMcpServers.delete(other);
      log("agent", `Disconnected ${other} MCP server (chat switch)`);
    } catch (err) {
      logWarn(
        "agent",
        `Failed to disconnect ${other} during chat switch: ${errMsg(err)}`,
      );
    }
  }

  // Local cache short-circuit. The upstream's GET /mcp returns {} regardless
  // of state, so we trust our own record of what we registered earlier in
  // this process. The upstream's POST /mcp is idempotent — a second `add`
  // for an existing name returns the current state without re-spawning the
  // subprocess — so the worst case of a stale cache is one wasted POST,
  // not a crash.
  if (state.registeredMcpServers.has(serverName)) {
    return serverName;
  }

  const startedAt = Date.now();
  try {
    await client.mcp.add({
      name: serverName,
      config: {
        type: "remote",
        // Talon's MCP hub serves the chat's tool set in-process over
        // streamable HTTP — no subprocess on the agent-server side, and
        // the (frontend, chatId) binding travels in the URL instead of
        // env. Tool-surface trimming is applied hub-side (initHub).
        // Bind the chat's OWNING frontend, not the process-primary one:
        // in multi-frontend deployments a native chat served by this
        // backend must get native-tools (send_message/end_turn), not
        // the primary frontend's tool surface.
        url: talonHubUrl(
          `http://127.0.0.1:${state.gatewayPortFn()}`,
          resolveChatToolFrontend(state, chatId),
          chatId,
        ),
      },
    });
    state.registeredMcpServers.add(serverName);
    const ms = Date.now() - startedAt;
    log(
      "agent",
      `Registered ${serverName} MCP server with ${state.label} (${ms}ms)` +
        (ms > SLOW_MCP_REGISTRATION_MS ? " [slow]" : ""),
    );
  } catch (err) {
    logWarn(
      "agent",
      `MCP registration failed for ${serverName} (tools may not be available): ${errMsg(err)}`,
    );
  }

  return serverName;
}

/**
 * Register all plugin-provided MCP servers with the upstream agent server.
 *
 * Plugins (mempalace, brave-search, github, …) expose MCP servers via
 * `getPluginMcpServers`. Each is registered under its plugin-provided
 * name so the model can see them in the tool catalog. Already-connected
 * servers are skipped via the local cache (their `name → process` mapping
 * survives the entire Talon process; only `stopRemoteServer` clears it).
 *
 * Returns the list of server names that ended up registered (either
 * freshly added or already connected).
 */
export async function ensurePluginMcpServers<TClient extends RemoteAgentClient>(
  client: TClient,
  state: RemoteServerState<TClient>,
  chatId: string,
): Promise<string[]> {
  const bridgeUrl = `http://127.0.0.1:${state.gatewayPortFn()}`;
  const names = hubPluginServerNames();
  const registered: string[] = [];

  for (const name of names) {
    if (state.registeredMcpServers.has(name)) {
      registered.push(name);
      continue;
    }
    try {
      const startedAt = Date.now();
      await client.mcp.add({
        name,
        config: {
          type: "remote",
          // Hub-managed child, shared across sessions and idle-reaped —
          // the agent server holds an HTTP connection, not a subprocess.
          url: pluginHubUrl(bridgeUrl, name, chatId),
        },
      });
      registered.push(name);
      state.registeredMcpServers.add(name);
      const ms = Date.now() - startedAt;
      log(
        "agent",
        `Registered plugin MCP server: ${name} (${ms}ms)` +
          (ms > SLOW_MCP_REGISTRATION_MS ? " [slow]" : ""),
      );
    } catch (err) {
      logWarn(
        "agent",
        `Plugin MCP registration failed for ${name}: ${errMsg(err)}`,
      );
    }
  }

  return registered;
}

/**
 * Build a `tools` override map that enables ONLY this chat's Talon tools.
 *
 * Upstream tool environment is global — every registered MCP server's
 * tools are visible to every session. Talon overrides per-prompt to keep
 * each session pinned to its own namespaced tools, denying cross-chat
 * access at the visibility layer (not just the execution layer that
 * permission rules cover).
 *
 * Returns `undefined` when no chat-scoped tools matched (e.g. MCP
 * registration failed silently above) — caller should skip passing
 * the `tools` field in that case.
 */
export async function buildToolOverrides<TClient extends RemoteAgentClient>(
  client: TClient,
  state: RemoteServerState<TClient>,
  chatServerName: string,
): Promise<Record<string, boolean> | undefined> {
  try {
    const toolIdsResp = await client.tool.ids();
    const toolIds = Array.isArray(toolIdsResp.data) ? toolIdsResp.data : [];
    const overrides: Record<string, boolean> = {};
    const chatToolPrefix = `${chatServerName}_`;
    let matchedChatTool = false;

    for (const toolId of toolIds) {
      if (typeof toolId !== "string" || !isTalonToolID(toolId)) continue;

      const enabled = toolId.startsWith(chatToolPrefix);
      overrides[toolId] = enabled;
      matchedChatTool ||= enabled;
    }

    return matchedChatTool ? overrides : undefined;
  } catch (err) {
    logWarn(
      "agent",
      `Failed to build ${state.label} tool overrides for ${chatServerName}: ${errMsg(err)}`,
    );
    return undefined;
  }
}

/**
 * Disconnect a per-chat MCP server. Called in handler `finally` blocks
 * to release the chat-namespaced MCP subprocess once the turn ends.
 *
 * Errors are swallowed (the server may already be gone if MCP itself
 * crashed). The local cache entry is removed unconditionally so a
 * future `ensureChatMcpServer` re-registers — otherwise the cache
 * short-circuit would skip a server the upstream no longer has.
 *
 * Note: Kilo's handler deliberately does NOT call this in its
 * per-turn `finally` (the disconnect-others-then-add dance in
 * `ensureChatMcpServer` handles the rotation, and re-registering the
 * same chat's server every turn costs ~800ms of subprocess spawn).
 * OpenCode's handler still calls it for now; the next refactor pass
 * will align both backends on the keep-across-turns policy.
 */
export async function disconnectChatMcpServer<
  TClient extends RemoteAgentClient,
>(
  client: TClient,
  state: RemoteServerState<TClient>,
  serverName: string,
): Promise<void> {
  try {
    await client.mcp.disconnect({ name: serverName });
    state.registeredMcpServers.delete(serverName);
  } catch (err) {
    logWarn("agent", `Failed to disconnect ${serverName}: ${errMsg(err)}`);
  }
}

/**
 * Snapshot of the locally-cached MCP server registrations. Test-only:
 * `registeredMcpServers` is module-private state that integration tests
 * need to inspect to assert chat-switch isolation actually fired (the
 * upstream's GET /mcp returns {} regardless of state, so we can't query
 * the server itself).
 */
export function getRegisteredMcpServerNames<TClient extends RemoteAgentClient>(
  state: RemoteServerState<TClient>,
): string[] {
  return [...state.registeredMcpServers];
}
