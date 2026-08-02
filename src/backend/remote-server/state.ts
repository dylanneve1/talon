/**
 * Per-backend state container for the remote-server family
 * (`opencode`, `kilo`).
 *
 * Each concrete backend owns one `RemoteServerState` instance — created at
 * `init` time, mutated by the shared helpers, cleared on `stop`. Holding
 * state on an instance instead of module globals lets the same shared code
 * back two distinct backends running in the same Talon process (e.g. tests)
 * without their MCP caches stomping each other.
 *
 * The state intentionally has NO methods — it's a plain bag of mutable
 * fields. The shared helpers (`mcp.ts`, `sessions.ts`, `lifecycle.ts`,
 * `providers.ts`) take a `RemoteServerState` argument and act on it. That
 * keeps the helpers easy to test (pass in a fake state, assert on its
 * fields) and avoids the "where does this method live" guessing game.
 */

import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../../core/agent-runtime/backend-registry.js";
import type { RemoteAgentClient } from "./client.js";

/** Mutable per-backend state shared across the lifecycle / mcp / session helpers. */
export interface RemoteServerState<TClient extends RemoteAgentClient> {
  /** Display label used in log lines (e.g. "Kilo", "OpenCode"). */
  readonly label: string;
  /** Hostname the local server binds to (almost always 127.0.0.1). */
  readonly hostname: string;
  /** TCP port the local server listens on. */
  readonly port: number;
  /** Convenience `http://<hostname>:<port>` URL. */
  readonly baseUrl: string;
  /** Cached Talon config (set at init time). */
  config: TalonConfig | null;
  /** Late-bound resolver for the Talon gateway port (used in MCP `environment`). */
  gatewayPortFn: () => number;
  /** Primary frontend driving this Talon process. */
  frontendName: FrontendName;
  /** Strongly-typed client once `ensureRemoteServer` resolves. */
  client: TClient | null;
  /** In-flight promise during the spawn race (`null` once settled). */
  clientPromise: Promise<TClient> | null;
  /** Server handle when we own the spawned process. `null` when we reused one. */
  serverHandle: { url: string; close(): void } | null;
  /**
   * Cache mapping a model id to its resolved provider id. Cleared on stop
   * so a restarted backend resolves against a fresh provider catalog.
   */
  readonly modelProviderCache: Map<string, string>;
  /**
   * Names of MCP servers we've registered during this process. Both
   * OpenCode and Kilo expose `GET /mcp` returning `{}` regardless of
   * actual state, so we cache locally instead of trusting the server.
   */
  readonly registeredMcpServers: Set<string>;
  /** Exact tool names exposed by each registered MCP server. */
  readonly registeredMcpTools: Map<string, readonly string[]>;
  /** Plugin-name → registered server-name mapping for each chat context. */
  readonly pluginMcpServersByChat: Map<string, Map<string, string>>;
}

/** Inputs for {@link createRemoteServerState}. */
export interface RemoteServerStateInputs {
  label: string;
  hostname: string;
  port: number;
  defaultGatewayPort?: number;
}

/**
 * Create a fresh state container for a remote-server backend. The state
 * starts empty — call `ensureRemoteServer` lazily on first use.
 */
export function createRemoteServerState<TClient extends RemoteAgentClient>(
  inputs: RemoteServerStateInputs,
): RemoteServerState<TClient> {
  const baseUrl = `http://${inputs.hostname}:${inputs.port}`;
  const defaultGatewayPort = inputs.defaultGatewayPort ?? 19876;
  return {
    label: inputs.label,
    hostname: inputs.hostname,
    port: inputs.port,
    baseUrl,
    config: null,
    gatewayPortFn: () => defaultGatewayPort,
    frontendName: "telegram",
    client: null,
    clientPromise: null,
    serverHandle: null,
    modelProviderCache: new Map(),
    registeredMcpServers: new Set(),
    registeredMcpTools: new Map(),
    pluginMcpServersByChat: new Map(),
  };
}

/** Common error→message helper used across the shared family. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
