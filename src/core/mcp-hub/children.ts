/**
 * Hub child manager — the single owner of external MCP server
 * subprocesses (plugins, brave-search).
 *
 * Before the hub, every chat turn (claude-sdk, codex) or every chat
 * lifetime (openai-agents, kilo/opencode) spawned its own copy of every
 * plugin MCP server — memory grew linearly with chats. The hub instead
 * keeps one child per key and reaps it after an idle TTL, so resident
 * cost tracks *recently active* keys, not every chat ever seen.
 *
 * Keys: chat-scoped plugins get `name + chatId` (they read
 * `TALON_CHAT_ID` at boot, so instances cannot be shared across chats
 * without changing plugin semantics); chat-agnostic servers (brave)
 * use a shared key. Either way the spec factory decides — this module
 * only manages lifecycles.
 *
 * Each child is spawned through the same supervisor wrap as before
 * (stdout JSON filtering + orphan cleanup if the daemon is SIGKILLed),
 * connected once over stdio, and shared by every hub session that
 * proxies to it. The tools list is cached per child lifetime — plugin
 * reload restarts children, which naturally invalidates the cache.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { log, logError, logWarn } from "../../util/log.js";

export type ChildSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type ChildHandle = {
  /** Cached tools/list result — fetched once per child lifetime. */
  listTools(): Promise<Tool[]>;
  /** Forward one tool call; tracked so retirement can drain in-flight work. */
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
  /** Mark activity so the idle reaper skips this child. */
  touch(): void;
};

type ChildEntry = {
  handle: ChildHandle;
  key: string;
  lastActivity: number;
  /** In-flight request count — retirement waits for this to hit zero. */
  pending: number;
  /**
   * Set when the child was replaced (plugin reload) but still has
   * in-flight calls. Closed as soon as `pending` drains (or by the
   * retire grace timer, whichever comes first).
   */
  retired: boolean;
  close: () => Promise<void>;
};

const children = new Map<string, ChildEntry>();
const inflight = new Map<string, Promise<ChildHandle>>();

/** Idle TTL for hub children; tunable for tests / tight deployments. */
function idleTtlMs(): number {
  const raw = Number(process.env.TALON_MCP_HUB_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000;
}

const REAP_INTERVAL_MS = 60_000;
let reaper: ReturnType<typeof setInterval> | null = null;

async function spawnChild(key: string, spec: ChildSpec): Promise<ChildHandle> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    // Merge over the daemon env — same visibility the SDK-spawned
    // subprocesses had (PATH, HOME, proxy vars, …).
    env: { ...(process.env as Record<string, string>), ...spec.env },
    stderr: "inherit",
  });
  const client = new Client(
    { name: "talon-mcp-hub", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  let toolsCache: Tool[] | null = null;
  const track = async <T>(fn: () => Promise<T>): Promise<T> => {
    entry.pending++;
    try {
      return await fn();
    } finally {
      entry.pending--;
      if (entry.retired && entry.pending === 0) {
        void entry.close();
      }
    }
  };
  const entry: ChildEntry = {
    key,
    lastActivity: Date.now(),
    pending: 0,
    retired: false,
    // Idempotent: retirement can race its own grace timer.
    close: (() => {
      let closing: Promise<void> | null = null;
      return () =>
        (closing ??= (async () => {
          try {
            await client.close();
          } catch (err) {
            logWarn("gateway", `hub child ${key} close failed: ${String(err)}`);
          }
        })());
    })(),
    handle: {
      touch: () => {
        entry.lastActivity = Date.now();
      },
      listTools: () =>
        track(async () => {
          if (toolsCache) return toolsCache;
          const result = await client.listTools();
          toolsCache = result.tools;
          return toolsCache;
        }),
      callTool: (name, args) =>
        track(
          () =>
            client.callTool({
              name,
              arguments: args,
            }) as Promise<CallToolResult>,
        ),
    },
  };

  // If the child dies on its own (crash, plugin bug), drop the entry so
  // the next request respawns instead of hitting a dead pipe forever.
  transport.onclose = () => {
    if (children.get(key) === entry) {
      children.delete(key);
      log("gateway", `hub child ${key} exited — will respawn on demand`);
    }
  };

  children.set(key, entry);
  log("gateway", `hub child started: ${key}`);
  return entry.handle;
}

/**
 * Return the live child for `key`, or spawn it from `spec()`. Concurrent
 * callers share one spawn. The spec factory is called only on spawn, so
 * it always reflects the current plugin registry (reload-safe).
 */
export function acquireChild(
  key: string,
  spec: () => ChildSpec,
): Promise<ChildHandle> {
  const existing = children.get(key);
  if (existing) {
    existing.lastActivity = Date.now();
    return Promise.resolve(existing.handle);
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      return await spawnChild(key, spec());
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

/** Close every child immediately. Daemon shutdown path. */
export async function closeAllChildren(): Promise<void> {
  const entries = [...children.values()];
  children.clear();
  await Promise.allSettled(entries.map((entry) => entry.close()));
  if (entries.length > 0) {
    log("gateway", `hub: closed ${entries.length} MCP child(ren)`);
  }
}

/**
 * Grace window for retired children: an in-flight tool call gets this
 * long to finish on the old process before it's closed under it.
 */
const RETIRE_GRACE_MS = 60_000;

/**
 * Retire every child: remove from the registry so the NEXT acquire
 * spawns fresh (reloaded plugin code), but let in-flight calls finish
 * on the old process. A chat mid-tool-call during `/reload-plugins`
 * sees its call complete normally; the old child closes once its last
 * call drains (or after the grace window, whichever comes first).
 */
export function retireAllChildren(): void {
  const entries = [...children.values()];
  children.clear();
  for (const entry of entries) {
    entry.retired = true;
    if (entry.pending === 0) {
      void entry.close();
      continue;
    }
    log(
      "gateway",
      `hub child ${entry.key} retired with ${entry.pending} in-flight call(s) — draining`,
    );
    const force = setTimeout(() => void entry.close(), RETIRE_GRACE_MS);
    force.unref?.();
  }
  if (entries.length > 0) {
    log("gateway", `hub: retired ${entries.length} MCP child(ren)`);
  }
}

function reapIdle(): void {
  const cutoff = Date.now() - idleTtlMs();
  for (const [key, entry] of children) {
    if (entry.lastActivity >= cutoff) continue;
    children.delete(key);
    entry.close().catch((err) => {
      logError("gateway", `hub reap of ${key} failed`, err);
    });
    log("gateway", `hub child reaped (idle): ${key}`);
  }
}

export function startChildReaper(): void {
  if (reaper) return;
  reaper = setInterval(reapIdle, REAP_INTERVAL_MS);
  reaper.unref?.();
}

export function stopChildReaper(): void {
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}

/** Diagnostic: live child keys (tests, /status introspection). */
export function getActiveChildKeys(): string[] {
  return [...children.keys()];
}
