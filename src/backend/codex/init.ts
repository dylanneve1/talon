/**
 * Codex backend initialisation.
 *
 * Spins up a long-lived `Codex` instance configured with:
 *
 *   - The MCP server map for the active chat, supplied as TOML config
 *     overrides via Codex's `--config` mechanism.
 *   - The OpenAI API key (from `OPENAI_API_KEY` env or Talon config).
 *   - The working directory (defaults to the user's home so Codex's
 *     `skipGitRepoCheck` covers operation outside a git repo).
 *
 * Codex's MCP servers are configured ONCE at thread-creation time. To
 * keep per-chat MCP isolation working with this constraint, Talon
 * re-creates the underlying `Codex` instance the first time it sees a
 * different chat id. Subsequent runs in the same chat reuse the cached
 * instance.
 *
 * Why not re-create per turn: spawning a fresh Codex subprocess per
 * message would cost ~1-2s of CLI startup overhead. The chat-id-keyed
 * cache amortises that to one spawn per chat lifetime.
 */

import { Codex, type CodexOptions } from "@openai/codex-sdk";
import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../registry.js";
import { log } from "../../util/log.js";
import { getState } from "./state.js";
import { buildCodexMcpServers } from "./mcp-config.js";

/**
 * Initialise the Codex backend.
 *
 * Stores config + gateway-port resolver + frontend label. Spawning the
 * Codex CLI is deferred until the first message arrives (lazy
 * initialisation).
 */
export function initCodexAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: FrontendName,
): void {
  const state = getState();
  state.config = cfg;
  if (getGatewayPort) state.gatewayPortFn = getGatewayPort;
  if (frontend) state.frontendName = frontend;
}

/**
 * Lazily build (or rebuild) the `Codex` instance for the active chat.
 *
 * Called by the handler at the top of each turn. Cheap when the active
 * chat hasn't changed (returns the cached instance); expensive on
 * first call or chat switch (rebuilds with the new MCP config).
 */
export function ensureCodex(chatId: string): Codex {
  const state = getState();
  if (!state.config) {
    throw new Error("Codex agent not initialized — call initCodexAgent first");
  }

  // Build the MCP server map for THIS chat. The map is baked into the
  // CLI config that the Codex instance ships with — i.e. it's
  // chat-specific from the moment the instance is constructed.
  const bridgeUrl = `http://127.0.0.1:${state.gatewayPortFn()}`;
  const frontends = getActiveFrontends(state.config.frontend);
  const mcpServers = buildCodexMcpServers({
    chatId,
    bridgeUrl,
    frontends,
    braveApiKey: state.config.braveApiKey,
  });

  // The Codex CLI's `--config` flag flattens dotted JSON paths into
  // TOML. We provide `mcp_servers.<name>.{command,args,env}` and the
  // SDK serialises it for us. CodexConfigObject only accepts
  // primitives + arrays + nested objects, so the cast is type-safe at
  // runtime even if the compiler can't prove it.
  const codexConfig: CodexOptions["config"] = {
    mcp_servers: mcpServers as unknown as Record<string, never>,
  };

  // Cache key: the chat id. When it changes, we rebuild.
  const cached = state.codex;
  if (
    cached &&
    (cached as Codex & { __talonChatId?: string }).__talonChatId === chatId
  ) {
    return cached;
  }

  const apiKey =
    process.env.OPENAI_API_KEY ?? state.config.openaiApiKey ?? undefined;

  const codex = new Codex({
    apiKey,
    config: codexConfig,
  });
  // Stash chat id on the instance for cache-key matching above.
  (codex as Codex & { __talonChatId?: string }).__talonChatId = chatId;

  state.codex = codex;
  log("agent", `Codex instance built for chat ${chatId}`);

  return codex;
}

function getActiveFrontends(
  frontend: TalonConfig["frontend"],
): readonly string[] {
  const all = Array.isArray(frontend) ? frontend : [frontend];
  return all.filter((f) => f !== "terminal");
}
