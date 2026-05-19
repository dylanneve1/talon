/**
 * Remote-server lifecycle helpers (shared by OpenCode and Kilo backends).
 *
 * Owns: lazy-spawn + reuse-if-already-listening, "ensure server is up"
 * race-safe waiter, and "tear it back down" cleanup.
 *
 * What's NOT here: MCP registration (see `./mcp.ts`), session creation
 * (see `./sessions.ts`), provider resolution (see `./providers.ts`).
 *
 * The lifecycle helpers are generic over `TClient extends RemoteAgentClient`
 * — the concrete backend (kilo or opencode) supplies a `createClient` /
 * `createServer` pair from its SDK and gets back the same lazy-spawn-or-
 * reuse machinery.
 */

import { log, logWarn } from "../../util/log.js";
import type { RemoteAgentClient } from "./client.js";
import type { RemoteServerState } from "./state.js";
import { errMsg } from "./state.js";

/**
 * Inputs passed to {@link ensureRemoteServer}. The backend supplies its
 * SDK's client/server factories; the shared helper handles the
 * spawn-race / reuse-existing-server bookkeeping.
 */
export interface EnsureRemoteServerInputs<TClient extends RemoteAgentClient> {
  state: RemoteServerState<TClient>;
  /** Create a strict client wrapping an already-running server URL. */
  createClient: (baseUrl: string) => TClient;
  /**
   * Spawn a fresh local server. Returns a `{ url, close }` handle —
   * `close()` will be called from `stopRemoteServer` when Talon shuts
   * down or hot-swaps backends.
   */
  createServer: (args: {
    hostname: string;
    port: number;
    timeout: number;
  }) => Promise<{ url: string; close(): void }>;
  /** Spawn timeout in ms (default 10s). */
  spawnTimeoutMs?: number;
  /**
   * Optional health-check path used by `reuseExistingServer`. Both OpenCode
   * and Kilo expose `/global/health` so the default works for the existing
   * backends; future remote servers can override.
   */
  healthPath?: string;
}

const DEFAULT_SPAWN_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_PATH = "/global/health";

/**
 * Lazily start (or reuse) the local agent server and return a client.
 *
 * Reuse path: probes `${baseUrl}/global/health` first. If a server is
 * already listening there (left over from a previous Talon process, or
 * co-tenant tooling on the same VPS), we wrap it instead of spawning a
 * duplicate. This is a real production scenario — Kilo's port 4097 is
 * frequently held by a prior Talon process when the new one starts up
 * from a systemd restart.
 *
 * Race-safe: a second caller while the first is mid-spawn awaits the
 * same `clientPromise` and never spawns a second server.
 */
export async function ensureRemoteServer<TClient extends RemoteAgentClient>(
  inputs: EnsureRemoteServerInputs<TClient>,
): Promise<TClient> {
  const {
    state,
    createClient,
    createServer,
    spawnTimeoutMs = DEFAULT_SPAWN_TIMEOUT_MS,
    healthPath = DEFAULT_HEALTH_PATH,
  } = inputs;

  if (state.client) return state.client;
  if (state.clientPromise) return state.clientPromise;

  state.clientPromise = (async () => {
    const existing = await reuseExistingServer({
      state,
      createClient,
      healthPath,
    });
    if (existing) {
      state.client = existing;
      return existing;
    }

    log("agent", `Starting ${state.label} server...`);
    const spawnStartedAt = Date.now();

    try {
      const server = await createServer({
        hostname: state.hostname,
        port: state.port,
        timeout: spawnTimeoutMs,
      });
      const client = createClient(server.url);
      state.client = client;
      state.serverHandle = server;
      log(
        "agent",
        `${state.label} server running at ${server.url} ` +
          `(spawned in ${Date.now() - spawnStartedAt}ms)`,
      );
      return client;
    } catch (err) {
      // Race-condition fallback: another process won the bind. Probe
      // health again — if it's now responding, wrap it. This handles
      // two Talon processes coming up simultaneously after a host reboot.
      const reused = await reuseExistingServer({
        state,
        createClient,
        healthPath,
      });
      if (reused) {
        state.client = reused;
        logWarn(
          "agent",
          `${state.label} server already became available at ${state.baseUrl}; ` +
            `reusing it`,
        );
        return reused;
      }
      throw err;
    }
  })();

  try {
    return await state.clientPromise;
  } finally {
    state.clientPromise = null;
  }
}

/** Inputs for the internal {@link reuseExistingServer} probe. */
interface ReuseExistingServerInputs<TClient extends RemoteAgentClient> {
  state: RemoteServerState<TClient>;
  createClient: (baseUrl: string) => TClient;
  healthPath: string;
}

/**
 * Probe `${state.baseUrl}${healthPath}` and return a wrapping client if
 * the upstream answered OK. Returns `null` on any error (network, non-2xx,
 * etc.) — caller falls through to spawning a fresh server.
 */
async function reuseExistingServer<TClient extends RemoteAgentClient>(
  inputs: ReuseExistingServerInputs<TClient>,
): Promise<TClient | null> {
  const { state, createClient, healthPath } = inputs;
  try {
    const response = await fetch(`${state.baseUrl}${healthPath}`);
    if (!response.ok) return null;
    const client = createClient(state.baseUrl);
    log("agent", `Reusing ${state.label} server at ${state.baseUrl}`);
    return client;
  } catch {
    return null;
  }
}

/**
 * Tear down the local server (if we own it) and clear all caches.
 *
 * Idempotent: safe to call multiple times. If we reused a pre-existing
 * server (via the reuse path above), this leaves it running — we don't
 * own it, so we shouldn't close it.
 *
 * Optional `extraCleanup` lets backends drop any backend-specific caches
 * (e.g. Kilo's model catalogue) without coupling the shared helper to
 * concrete cache modules.
 */
export function stopRemoteServer<TClient extends RemoteAgentClient>(
  state: RemoteServerState<TClient>,
  extraCleanup?: () => void,
): void {
  state.clientPromise = null;
  state.modelProviderCache.clear();
  state.registeredMcpServers.clear();
  try {
    extraCleanup?.();
  } catch (err) {
    logWarn(
      "agent",
      `${state.label} extra cleanup failed (non-fatal): ${errMsg(err)}`,
    );
  }
  if (state.serverHandle) {
    state.serverHandle.close();
    state.serverHandle = null;
    state.client = null;
    log("agent", `${state.label} server stopped`);
  }
}
