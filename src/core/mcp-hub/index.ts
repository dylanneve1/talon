/**
 * MCP hub — daemon-hosted MCP over streamable HTTP, one endpoint for
 * every backend.
 *
 * Motivation: every backend used to spawn its own stdio copy of every
 * MCP server per chat (claude-sdk/codex per turn; openai-agents and
 * kilo/opencode per chat, held indefinitely) — two processes per server
 * per chat once the supervisor wrap is counted. Memory grew linearly
 * with chats. The hub inverts the ownership: the daemon hosts
 *
 *   /mcp/talon/<frontend>/<chatId>   Talon's own tools, IN-PROCESS
 *                                    (zero subprocesses; chat binding
 *                                    comes from the URL, not env)
 *   /mcp/plugin/<serverName>/<chatId> external plugin / brave servers,
 *                                    proxied to hub-managed children
 *                                    that are shared across sessions
 *                                    and reaped when idle
 *
 * and every backend connects with its SDK's HTTP/remote MCP transport
 * (claude-sdk `type:"http"`, openai-agents `MCPServerStreamableHttp`,
 * codex `mcp_servers.<name>.url`, kilo/opencode `type:"remote"`).
 *
 * What stays exactly as before:
 *   - per-chat tool isolation (binding is per-session from the URL)
 *   - plugin semantics (chat-scoped children keep TALON_CHAT_ID env)
 *   - tool-surface trimming (disabledTools / disabledToolTags)
 *   - plugin reloading (reload closes children; next request respawns
 *     from the current registry — see reloadHubChildren)
 *   - orphan cleanup (children still run under the supervisor wrap)
 *
 * Endpoints live on the gateway HTTP server (127.0.0.1-bound, same
 * trust boundary as /action).
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { getPluginMcpServers } from "../plugin/index.js";
import { wrapMcpServer } from "../../util/mcp-launcher.js";
import { log, logError } from "../../util/log.js";
import { buildTalonToolServer, VALID_TOOL_FRONTENDS } from "./talon-server.js";
import { buildProxyServer } from "./proxy-server.js";
import {
  acquireChild,
  closeAllChildren,
  retireAllChildren,
  startChildReaper,
  stopChildReaper,
  type ChildSpec,
} from "./children.js";
import type { ToolFrontend } from "../tools/types.js";

export const HUB_PATH_PREFIX = "/mcp/";

// ── Config ──────────────────────────────────────────────────────────────────

export type HubConfig = {
  disabledTools?: readonly string[];
  disabledToolTags?: readonly string[];
  braveApiKey?: string;
};

let hubConfig: HubConfig = {};

/** Set at bootstrap; safe to call again on config reload. */
export function initHub(config: HubConfig): void {
  hubConfig = config;
  startChildReaper();
}

// ── URL builders (used by every backend) ────────────────────────────────────

/** URL of the in-process Talon tool server for one (frontend, chat). */
export function talonHubUrl(
  bridgeUrl: string,
  frontend: string,
  chatId: string,
): string {
  return `${bridgeUrl}${HUB_PATH_PREFIX}talon/${encodeURIComponent(frontend)}/${encodeURIComponent(chatId)}`;
}

/** URL of a hub-proxied plugin/brave server for one chat. */
export function pluginHubUrl(
  bridgeUrl: string,
  serverName: string,
  chatId: string,
): string {
  return `${bridgeUrl}${HUB_PATH_PREFIX}plugin/${encodeURIComponent(serverName)}/${encodeURIComponent(chatId)}`;
}

/**
 * Names of every hub-served plugin server — what backends enumerate to
 * build their per-chat URL maps. Registry-backed, so it reflects plugin
 * reloads immediately. (brave-search is served by the hub too, but each
 * backend adds it explicitly alongside its frontend tools, matching the
 * pre-hub structure.)
 */
export function hubPluginServerNames(only?: string[]): string[] {
  // Specs are built with placeholder identity — only the names matter.
  return Object.keys(getPluginMcpServers("", "hub-enum", only));
}

// ── Server construction per session ─────────────────────────────────────────

type HubTarget =
  | { kind: "talon"; frontend: ToolFrontend; chatId: string }
  | { kind: "plugin"; serverName: string; chatId: string };

function parseHubPath(rawUrl: string): HubTarget | null {
  const path = rawUrl.split("?")[0];
  if (!path.startsWith(HUB_PATH_PREFIX)) return null;
  const parts = path
    .slice(HUB_PATH_PREFIX.length)
    .split("/")
    .map((part) => decodeURIComponent(part));
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  const [kind, name, chatId] = parts;
  if (kind === "talon") {
    if (!VALID_TOOL_FRONTENDS.has(name)) return null;
    return { kind: "talon", frontend: name as ToolFrontend, chatId };
  }
  if (kind === "plugin") return { kind: "plugin", serverName: name, chatId };
  return null;
}

function braveSpec(): ChildSpec {
  return wrapMcpServer({
    command: resolve(
      import.meta.dirname ?? ".",
      "../../../node_modules/.bin/brave-search-mcp-server",
    ),
    args: [],
    env: { BRAVE_API_KEY: hubConfig.braveApiKey ?? "" },
  });
}

/**
 * Resolve the child spec for a plugin server name. Looked up lazily at
 * spawn time so a reload always spawns from the current registry.
 * Throws when the name is unknown (plugin removed / never existed).
 */
function pluginSpec(
  serverName: string,
  chatId: string,
  bridgeUrl: string,
): ChildSpec {
  if (serverName === "brave-search") return braveSpec();
  const specs = getPluginMcpServers(bridgeUrl, chatId);
  const spec = specs[serverName];
  if (!spec) throw new Error(`Unknown hub plugin server: ${serverName}`);
  return { command: spec.command, args: [...spec.args], env: spec.env };
}

/** Test-only: expose the spec resolution for the pass-through contract. */
export const _pluginSpecForTesting = pluginSpec;

function buildServerFor(target: HubTarget, bridgeUrl: string) {
  if (target.kind === "talon") {
    return buildTalonToolServer({
      frontend: target.frontend,
      chatId: target.chatId,
      bridgeUrl,
      disabledTools: hubConfig.disabledTools,
      disabledToolTags: hubConfig.disabledToolTags,
    });
  }
  // brave-search is chat-agnostic (one shared child); plugins read
  // TALON_CHAT_ID at boot, so their children stay chat-scoped and the
  // idle reaper bounds the fleet.
  const key =
    target.serverName === "brave-search"
      ? "brave-search"
      : `${target.serverName}\u0000${target.chatId}`;
  return buildProxyServer(target.serverName, () =>
    acquireChild(key, () =>
      pluginSpec(target.serverName, target.chatId, bridgeUrl),
    ),
  );
}

// ── Session registry ────────────────────────────────────────────────────────

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
};

const sessions = new Map<string, SessionEntry>();

/**
 * Sessions whose client vanished without a DELETE (crashed subprocess,
 * kill -9) are closed after this idle window. Every well-behaved client
 * terminates explicitly, so this only catches stragglers.
 */
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_REAP_INTERVAL_MS = 5 * 60_000;
let sessionReaper: ReturnType<typeof setInterval> | null = null;

function startSessionReaper(): void {
  if (sessionReaper) return;
  sessionReaper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, entry] of sessions) {
      if (entry.lastSeen >= cutoff) continue;
      sessions.delete(id);
      entry.transport.close().catch(() => {});
      log("gateway", `hub session reaped (idle): ${id.slice(0, 8)}…`);
    }
  }, SESSION_REAP_INTERVAL_MS);
  sessionReaper.unref?.();
}

// ── HTTP entry point (invoked by the gateway) ───────────────────────────────

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function jsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

/**
 * Handle one request under /mcp/. `bridgeUrl` is the gateway's own base
 * URL (the gateway knows its bound port; the hub does not).
 */
export async function handleHubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  bridgeUrl: string,
): Promise<void> {
  startSessionReaper();
  try {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const entry = sessions.get(sessionId);
      if (!entry) {
        jsonRpcError(res, 404, "Unknown or expired MCP session");
        return;
      }
      entry.lastSeen = Date.now();
      await entry.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== "POST") {
      jsonRpcError(res, 405, "Method not allowed without a session");
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      jsonRpcError(res, 400, "Invalid JSON body");
      return;
    }
    if (!isInitializeRequest(body)) {
      jsonRpcError(res, 400, "Expected an initialize request");
      return;
    }

    const target = parseHubPath(req.url ?? "");
    if (!target) {
      jsonRpcError(res, 404, "Unknown hub endpoint");
      return;
    }

    const server = buildServerFor(target, bridgeUrl);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    logError("gateway", `hub request failed: ${req.method} ${req.url}`, err);
    if (!res.headersSent) {
      jsonRpcError(res, 500, "Internal hub error");
    }
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Plugin reload: RETIRE every child — the next request (from any chat)
 * spawns fresh processes running the reloaded plugin code, while calls
 * already in flight finish on the old process instead of erroring
 * mid-turn. Live sessions keep working — their proxies re-acquire on
 * the next call.
 */
export function reloadHubChildren(): void {
  retireAllChildren();
}

/** Daemon shutdown: close sessions, children, and timers. */
export async function shutdownHub(): Promise<void> {
  stopChildReaper();
  if (sessionReaper) {
    clearInterval(sessionReaper);
    sessionReaper = null;
  }
  const entries = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(entries.map((entry) => entry.transport.close()));
  await closeAllChildren();
}

/** Diagnostic: live hub session count. */
export function getHubSessionCount(): number {
  return sessions.size;
}
