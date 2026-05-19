/**
 * Antigravity backend initialisation.
 *
 * Holds onto the Talon config + gateway port + frontend name. Real
 * bridge spawning happens lazily in `ensureBridge(chatId)` from the
 * handler — the cost of starting `localharness` (~1s) only hits the
 * first turn of each chat.
 */

import { resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../registry.js";
import { log, logWarn } from "../../util/log.js";
import { getState } from "./state.js";
import { buildAntigravityMcpServers } from "./mcp-config.js";
import { AntigravityBridge } from "./python-bridge.js";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_DEFAULT_WORKSPACE_DIR,
} from "./constants.js";

function expandHome(p: string | undefined): string | undefined {
  if (!p) return p;
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function defaultWorkspacePath(): string {
  return resolve(homedir(), ANTIGRAVITY_DEFAULT_WORKSPACE_DIR);
}

function ensureDirectory(p: string): void {
  try {
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
    }
  } catch (e) {
    logWarn(
      "agent",
      `Antigravity: failed to ensure workspace dir ${p}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export function initAntigravityAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: FrontendName,
): void {
  const state = getState();
  state.config = cfg;
  if (getGatewayPort) state.gatewayPortFn = getGatewayPort;
  if (frontend) state.frontendName = frontend;

  const cfgRecord = cfg as unknown as Record<string, unknown>;
  const geminiKey =
    (typeof cfgRecord.geminiApiKey === "string"
      ? (cfgRecord.geminiApiKey as string)
      : undefined) ?? process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    logWarn(
      "agent",
      "Antigravity: no GEMINI_API_KEY env and no geminiApiKey in talon.json. " +
        "First turn will fail with 'API key not valid' until either is set. " +
        "Get a key at https://aistudio.google.com/.",
    );
  } else {
    log("agent", "Antigravity auth: gemini-api-key configured");
  }

  // Ensure the default workspace exists if no override is configured.
  const wsOverride =
    typeof cfgRecord.antigravityWorkspace === "string"
      ? expandHome(cfgRecord.antigravityWorkspace as string)
      : undefined;
  const workspacePath = wsOverride ?? defaultWorkspacePath();
  ensureDirectory(workspacePath);
}

/**
 * Lazily start (or reuse) the bridge subprocess for a chat.
 *
 * The bridge is keyed by chat id because Antigravity bakes the MCP
 * server map into the agent context at start time, and our
 * frontend-tools MCP server is chat-scoped. Switching chats means
 * spawning a fresh bridge.
 */
export async function ensureBridge(
  chatId: string,
): Promise<AntigravityBridge> {
  const state = getState();
  if (!state.config) {
    throw new Error(
      "Antigravity agent not initialised — call initAntigravityAgent first",
    );
  }

  const existing = state.bridges.get(chatId);
  if (existing && existing.isReady()) {
    return existing;
  }

  const bridgeUrl = `http://127.0.0.1:${state.gatewayPortFn()}`;
  const frontends = getActiveFrontends(state.config.frontend);
  const mcpServers = buildAntigravityMcpServers({
    chatId,
    bridgeUrl,
    frontends,
    braveApiKey: state.config.braveApiKey,
  });

  const cfgRecord = state.config as unknown as Record<string, unknown>;
  const geminiKey =
    (typeof cfgRecord.geminiApiKey === "string"
      ? (cfgRecord.geminiApiKey as string)
      : undefined) ?? process.env.GEMINI_API_KEY;
  const model = state.config.model ?? ANTIGRAVITY_DEFAULT_MODEL;

  const wsOverride =
    typeof cfgRecord.antigravityWorkspace === "string"
      ? expandHome(cfgRecord.antigravityWorkspace as string)
      : undefined;
  const workspacePath = wsOverride ?? defaultWorkspacePath();

  const pythonPath =
    typeof cfgRecord.antigravityPython === "string"
      ? expandHome(cfgRecord.antigravityPython as string)
      : undefined;

  const bridge = new AntigravityBridge(chatId);
  await bridge.start(
    {
      gemini_api_key: geminiKey,
      model: model === "default" ? ANTIGRAVITY_DEFAULT_MODEL : model,
      workspaces: [workspacePath],
      mcp_servers: mcpServers,
      // system_instructions is supplied per-turn via the chat prompt
      // (Talon's first-turn prompt rebuild wires the full system
      // suffix in there). We pass `undefined` here so the SDK uses
      // its default — Talon owns the prompt shape.
    },
    {
      pythonPath,
    },
  );

  // If we replaced an existing-but-dead bridge, tear it down.
  if (existing) {
    void existing.shutdown();
  }
  state.bridges.set(chatId, bridge);
  log("agent", `Antigravity bridge ready for chat ${chatId}`);
  return bridge;
}

function getActiveFrontends(
  frontend: TalonConfig["frontend"],
): readonly string[] {
  const all = Array.isArray(frontend) ? frontend : [frontend];
  return all.filter((f) => f !== "terminal");
}
