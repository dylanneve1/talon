/**
 * Module-level state for the Claude SDK backend.
 *
 * Owns the mutable config and bridge port references and exposes
 * initialization functions + internal getters for sibling modules.
 */

import type { TalonConfig } from "../../util/config.js";
import { registerClaudeModels } from "./models.js";

// ── State ────────────────────────────────────────────────────────────────────

let config: TalonConfig | undefined;
let bridgePortFn: () => number = () => 19876;

// ── Public API (re-exported from barrel) ────────────────────────────────────

export function initAgent(
  cfg: TalonConfig,
  getBridgePort?: () => number,
): void {
  config = cfg;
  if (getBridgePort) bridgePortFn = getBridgePort;

  // Register static models immediately, then discover live models from SDK
  registerClaudeModels({
    model: cfg.model,
    cwd: cfg.workspace,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    ...(cfg.claudeBinary
      ? { pathToClaudeCodeExecutable: cfg.claudeBinary }
      : {}),
  });

  // The Agent SDK spawns an embedded Claude Code subprocess.
  // If CLAUDECODE is set (e.g. running from a Claude Code terminal),
  // the subprocess refuses to start with a nested-session error that
  // gets swallowed — causing an infinite hang on Windows.
  delete process.env.CLAUDECODE;
}

/** Update the system prompt on the live config. Used by plugin hot-reload
 *  so the next message picks up new plugin tool descriptions. */
export function updateSystemPrompt(prompt: string): void {
  if (config) config.systemPrompt = prompt;
}

// ── Internal getters (used by sibling modules, NOT re-exported) ─────────────

export function getConfig(): TalonConfig {
  if (!config)
    throw new Error("Agent not initialized. Call initAgent() first.");
  return config;
}

export function getBridgePort(): number {
  return bridgePortFn();
}
