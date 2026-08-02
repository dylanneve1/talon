/**
 * Shared session-lifecycle helpers for the remote-server backend family.
 *
 * Owns: `ensureRemoteSession` — resume the stored session id if valid,
 * otherwise create a fresh one with Talon's standard permission ruleset.
 *
 * What's NOT here: prompt dispatch (kilo uses `promptAsync` + SSE; opencode
 * uses sync `prompt`), question-watchdog loops (each backend has its own
 * driver), or the final messages-list walk (different SDK shapes).
 */

import {
  getSession,
  resetSession,
  setSessionId,
} from "../../storage/sessions.js";
import { log, logWarn } from "../../util/log.js";
import type { RemoteAgentClient, RemotePermissionRule } from "./client.js";
import type { RemoteServerState } from "./state.js";
import {
  TALON_MCP_SERVER_NAME,
  TALON_PLUGIN_MCP_SERVER_NAME,
  getChatMcpServerName,
  safeMcpNamePart,
} from "./mcp.js";

/**
 * Build the per-session permission ruleset Talon installs on every fresh
 * session.
 *
 * Two jobs:
 *
 *   1. Hide other chats' MCP tools from this session. Upstream exposes
 *      every registered MCP server's tools to every session by default,
 *      so a model in chat A would happily call
 *      `talon-tools-<chatB>_send`. The bridge then routes to chat B,
 *      which fails the gateway's active-context check and returns
 *      "No active chat context". Or in the cross-chat case where chat B
 *      IS active, the model in chat A could leak content into chat B.
 *      Deny pattern blocks both. (Visibility is also blocked at the
 *      prompt layer by `buildToolOverrides`; this rule is defense in depth.)
 *
 *   2. Auto-allow built-in tools (`tool *`, `edit *`, `bash *`) and
 *      workspace paths outside the server process's launch directory so they
 *      don't sit in `permission.asked` waiting for a reply that never
 *      arrives. The permission watchdog is a fallback for new categories;
 *      this rule resolves the known path case without a polling round trip.
 *
 * Rules are evaluated in order; first match wins. (See upstream's
 * `PermissionRule` type — `permission` is the rule category, `pattern`
 * is a glob.)
 */
export function buildPermissionRuleset(chatId: string): RemotePermissionRule[] {
  const ourServerName = getChatMcpServerName(chatId);
  const ourPluginPrefix = `${TALON_PLUGIN_MCP_SERVER_NAME}-${safeMcpNamePart(chatId, "chat")}-`;
  return [
    { permission: "tool", pattern: `${ourServerName}_*`, action: "allow" },
    {
      permission: "tool",
      pattern: `${TALON_MCP_SERVER_NAME}-*`,
      action: "deny",
    },
    { permission: "tool", pattern: `${ourPluginPrefix}*`, action: "allow" },
    {
      permission: "tool",
      pattern: `${TALON_PLUGIN_MCP_SERVER_NAME}-*`,
      action: "deny",
    },
    { permission: "tool", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "allow" },
  ];
}

/**
 * Ensure a session exists for this chat on the remote agent server.
 *
 * Resumes the stored session id if `session.get` confirms it's still
 * alive. If the stored id is stale (any failure from `session.get`),
 * resets local state and creates a fresh session, returning the new
 * id. The fresh session is created with Talon's standard permission
 * ruleset (see {@link buildPermissionRuleset}).
 */
export async function ensureRemoteSession<TClient extends RemoteAgentClient>(
  client: TClient,
  state: RemoteServerState<TClient>,
  chatId: string,
): Promise<string> {
  const session = getSession(chatId);

  if (session.sessionId) {
    try {
      await client.session.get({ sessionID: session.sessionId });
      return session.sessionId;
    } catch {
      logWarn(
        "agent",
        `[${chatId}] Session ${session.sessionId} expired, creating new`,
      );
      resetSession(chatId);
    }
  }

  const permission = buildPermissionRuleset(chatId);
  const resp = await client.session.create({
    title: `Chat ${chatId}`,
    permission,
  });
  const data = resp.data as Record<string, unknown> | undefined;
  const newId = (data?.id as string) ?? String(Date.now());
  setSessionId(chatId, newId);
  log(
    "agent",
    `[${chatId}] Created ${state.label} session: ${newId} ` +
      `(scoped to ${getChatMcpServerName(chatId)}_*)`,
  );

  return newId;
}

/**
 * The per-turn setup a warm-up front-loads. Both remote-server backends
 * expose these under identical signatures; the shape lets the helper stay
 * backend-agnostic without importing either SDK.
 */
export interface RemoteWarmDeps<TClient extends RemoteAgentClient> {
  ensureServer(): Promise<TClient>;
  ensureSession(client: TClient, chatId: string): Promise<string>;
  ensureChatMcpServer(client: TClient, chatId: string): Promise<string>;
  ensurePluginMcpServers(client: TClient, chatId: string): Promise<string[]>;
}

/**
 * Pre-pay a chat's cold start: spawn the server if it isn't up, create (or
 * resume) the session, and register the chat + plugin MCP servers.
 *
 * This is the remote-server analogue of the Claude backend's `warmSession`,
 * and closes the last `sessions` capability gap between the two families.
 * `performSessionReset` and the native frontend call it right after a reset,
 * so the first turn on a fresh session doesn't serially pay session creation
 * plus a full plugin-MCP registration sweep — the dominant cold-start cost
 * here, since each plugin server is a separate connect.
 *
 * Best-effort by contract: `/reset` has already succeeded by the time this
 * runs, and the same work is idempotent and repeated at the head of every
 * turn. A failure must degrade to a slow first turn, never surface as a
 * failed reset — so everything is caught and logged, not rethrown.
 */
export async function warmRemoteSession<TClient extends RemoteAgentClient>(
  state: RemoteServerState<TClient>,
  chatId: string,
  deps: RemoteWarmDeps<TClient>,
): Promise<void> {
  try {
    const client = await deps.ensureServer();
    await deps.ensureSession(client, chatId);
    await deps.ensureChatMcpServer(client, chatId);
    await deps.ensurePluginMcpServers(client, chatId);
    log("agent", `[${chatId}] Warmed ${state.label} session`);
  } catch (err) {
    logWarn(
      "agent",
      `[${chatId}] ${state.label} warm-up skipped (first turn pays cold start): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
