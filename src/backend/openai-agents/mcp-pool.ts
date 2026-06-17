/**
 * Per-chat persistent MCP bundle pool for the OpenAI Agents backend.
 *
 * Background
 * ──────────
 *
 * The original openai-agents handler called `buildOpenAIAgentsMcpServers`
 * once per turn and closed every spawned subprocess in `finally`. With
 * ~15 plugins active that's ~15 subprocess spawns per message per chat,
 * which on a small VPS:
 *
 *   - adds 1–10s of cold-start latency to every turn,
 *   - intermittently races out as `MCP error -32001: Request timed out`
 *     when the spawn fan-out collides with another chat's MCP setup,
 *   - wastes 15× `cacheToolsList` opportunities — the SDK re-fetches
 *     every tool definition for every server on every turn.
 *
 * The Claude SDK backend keeps its MCP subprocess set alive for the
 * lifetime of the per-chat session and reuses them across turns. This
 * module brings the same pattern to openai-agents.
 *
 * Architecture
 * ────────────
 *
 *   - A `Map<chatId, OpenAIAgentsMcpBundle>` caches one bundle per chat.
 *   - `getOrCreateBundle(args)` returns the cached bundle, or builds +
 *     connects a fresh one (using `connectMcpServers` from the SDK for
 *     proper per-server timeouts + failure tracking).
 *   - `releaseBundle(chatId)` closes the bundle's subprocesses and drops
 *     the entry. Use when a chat is rebound off openai-agents, on
 *     session reset, or when the chat is destroyed.
 *   - `releaseAllBundles()` is the backend cleanup path — closes every
 *     live bundle so the factory's cleanup hook leaves no orphans.
 *
 * Concurrency
 * ───────────
 *
 * `getOrCreateBundle` serialises the build-or-return decision on a
 * per-chat in-flight Promise so two concurrent turns from the same chat
 * (cross-frontend, e.g. Telegram + Discord) reuse one bundle rather
 * than double-spawn. Different chats build independently in parallel.
 */

import { connectMcpServers, MCPServerStdio } from "@openai/agents";
import type { MCPServer } from "@openai/agents";
import { resolve } from "node:path";
import { wrapMcpCommand } from "../../util/mcp-launcher.js";
import { getPluginMcpServers } from "../../core/plugin/index.js";
import {
  buildTalonMcpEnv,
  talonMcpServerCommand,
  type ToolExclusionConfig,
} from "../../core/tools/mcp-env.js";
import { log, logWarn } from "../../util/log.js";

/**
 * One per-chat bundle. Subprocesses stay alive until `close()` is
 * called via `releaseBundle()` / `releaseAllBundles()`.
 */
export interface OpenAIAgentsMcpBundle {
  /**
   * Connected MCP servers ready to pass to `new Agent({ mcpServers })`.
   * `connectMcpServers` returns the structural `MCPServer` type — the
   * underlying instances are `MCPServerStdio` but the Agent constructor
   * only needs the interface.
   */
  servers: MCPServer[];
  /** Close every spawned subprocess. Safe to call multiple times. */
  close: () => Promise<void>;
  /** Servers that failed to connect — exposed for diagnostics. */
  failed: ReadonlyArray<{ name: string; error: string }>;
}

/**
 * Inputs for {@link getOrCreateBundle}. Everything but `chatId` is
 * effectively constant across turns for a given Talon process — they're
 * passed per-call so the module doesn't have to import state.
 */
export interface BundleInputs {
  chatId: string;
  bridgeUrl: string;
  frontends: readonly string[];
  braveApiKey?: string;
  /** Tool-surface trimming slice of the Talon config. */
  toolExclusions?: ToolExclusionConfig | null;
}

/** Live bundles keyed by chatId. */
const bundles = new Map<string, OpenAIAgentsMcpBundle>();
/** In-flight build promises so concurrent gets share one build. */
const inflight = new Map<string, Promise<OpenAIAgentsMcpBundle>>();

/**
 * Return the cached bundle for `chatId`, or build + connect a new one.
 *
 * Build path uses the SDK's `connectMcpServers` helper for clean
 * lifecycle management: per-server connect timeouts (10s default),
 * `failed`/`errors` collections instead of fail-the-whole-bundle,
 * `dropFailed: true` so one bad plugin doesn't take down the rest.
 *
 * Every server is constructed with `cacheToolsList: true` so the SDK
 * fetches the tool definitions exactly once per server-lifetime instead
 * of re-listing on every turn.
 */
export async function getOrCreateBundle(
  args: BundleInputs,
): Promise<OpenAIAgentsMcpBundle> {
  const cached = bundles.get(args.chatId);
  if (cached) return cached;

  const pending = inflight.get(args.chatId);
  if (pending) return pending;

  const promise = (async (): Promise<OpenAIAgentsMcpBundle> => {
    try {
      const bundle = await buildBundle(args);
      bundles.set(args.chatId, bundle);
      return bundle;
    } finally {
      inflight.delete(args.chatId);
    }
  })();

  inflight.set(args.chatId, promise);
  return promise;
}

/**
 * Close the bundle for `chatId` and drop it from the pool. No-op when
 * the chat has no live bundle.
 *
 * Call when:
 *   - The chat rebinds to a non-openai-agents backend.
 *   - The user runs `/reset`.
 *   - The chat is destroyed.
 *
 * If `getOrCreateBundle` is in flight when called, releases the bundle
 * once the in-flight build resolves to avoid leaving an unreleased
 * subprocess set.
 */
export async function releaseBundle(chatId: string): Promise<void> {
  // If a build is in flight, wait for it then close the result.
  const pending = inflight.get(chatId);
  if (pending) {
    try {
      const bundle = await pending;
      await bundle.close();
    } catch {
      // Build threw — nothing to close. Already cleaned via build's
      // own error path.
    }
    bundles.delete(chatId);
    return;
  }

  const bundle = bundles.get(chatId);
  if (!bundle) return;
  bundles.delete(chatId);
  await bundle.close().catch((err) => {
    logWarn(
      "agent",
      `[${chatId}] MCP bundle close failed: ${errMsg(err)} (continuing)`,
    );
  });
}

/**
 * Close every live bundle. Used by the backend factory's `cleanup`
 * hook so unbinding the openai-agents backend leaves no orphan MCP
 * subprocesses.
 */
export async function releaseAllBundles(): Promise<void> {
  const ids = [...bundles.keys()];
  await Promise.allSettled(ids.map((id) => releaseBundle(id)));
}

/**
 * Diagnostic: how many live bundles + their chat ids. Exposed for
 * tests and `/status`-style introspection.
 */
export function getActiveBundleIds(): readonly string[] {
  return [...bundles.keys()];
}

// ── Internal: build + connect ───────────────────────────────────────────────

async function buildBundle(args: BundleInputs): Promise<OpenAIAgentsMcpBundle> {
  const { chatId, bridgeUrl, frontends, braveApiKey } = args;

  const built: MCPServerStdio[] = [];

  // Frontend MCP tool servers (one per non-terminal frontend). Each
  // exposes the Talon-native delivery surface (send, react, end_turn,
  // …) for that frontend, scoped to `chatId`. Spawn spec is shared —
  // see talonMcpServerCommand for the tsx-loader / Windows rationale.
  for (const frontend of frontends) {
    const wrapped = wrapMcpCommand(talonMcpServerCommand());
    built.push(
      new MCPServerStdio({
        name: `${frontend}-tools`,
        command: wrapped[0],
        args: wrapped.slice(1),
        env: buildTalonMcpEnv({
          bridgeUrl,
          chatId,
          frontend,
          config: args.toolExclusions,
        }),
        cacheToolsList: true,
      }),
    );
  }

  // Brave Search MCP server (if configured).
  if (braveApiKey) {
    const braveCommand = resolve(
      import.meta.dirname ?? ".",
      "../../../node_modules/.bin/brave-search-mcp-server",
    );
    built.push(
      new MCPServerStdio({
        name: "brave-search",
        command: braveCommand,
        args: [],
        env: { BRAVE_API_KEY: braveApiKey },
        cacheToolsList: true,
      }),
    );
  }

  // Plugin MCP servers. `getPluginMcpServers` already runs each command
  // through the supervisor wrap (`wrapMcpServer`), so the returned
  // command/args are launcher-ready — do NOT wrap a second time.
  const pluginServers = getPluginMcpServers(bridgeUrl, chatId);
  for (const [name, cfg] of Object.entries(pluginServers)) {
    built.push(
      new MCPServerStdio({
        name,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env ?? {},
        cacheToolsList: true,
      }),
    );
  }

  // Use the SDK's lifecycle helper. Parallel connect, per-server
  // timeout (10s default), failed servers tracked in `.failed` rather
  // than failing the whole bundle. `dropFailed: true` (default) means
  // `.active` only includes the ones that successfully connected.
  const mcpServers = await connectMcpServers(built, {
    connectInParallel: true,
  });

  const failedInfo: { name: string; error: string }[] = [];
  for (const [server, error] of mcpServers.errors) {
    failedInfo.push({ name: server.name, error: errMsg(error) });
    logWarn(
      "agent",
      `[${chatId}] MCP server ${server.name} failed to connect: ${errMsg(error)}`,
    );
  }

  log(
    "agent",
    `[${chatId}] MCP bundle ready: ${mcpServers.active.length} server(s) connected` +
      (failedInfo.length > 0 ? `, ${failedInfo.length} failed` : ""),
  );

  const bundle: OpenAIAgentsMcpBundle = {
    servers: mcpServers.active,
    failed: failedInfo,
    close: async () => {
      await mcpServers.close().catch((err) => {
        logWarn("agent", `MCP bundle close failed: ${errMsg(err)}`);
      });
    },
  };
  return bundle;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
