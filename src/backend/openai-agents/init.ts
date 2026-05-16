/**
 * OpenAI Agents backend initialisation.
 *
 * No long-running server, no per-chat instance cache — the SDK is
 * stateless from Talon's side. We only capture config + frontend +
 * gateway-port resolver at init, plus surface an auth-mode log line
 * so operators know whether `OPENAI_API_KEY` actually resolves.
 */

import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../registry.js";
import { log, logWarn } from "../../util/log.js";
import { getState } from "./state.js";

/**
 * Initialise the OpenAI Agents backend.
 *
 * The agents SDK speaks to OpenAI's Responses API and requires an
 * API key. This function records whether one is available so the
 * startup log surfaces the result before any turn fires.
 */
export function initOpenAIAgentsAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: FrontendName,
): void {
  const state = getState();
  state.config = cfg;
  if (getGatewayPort) state.gatewayPortFn = getGatewayPort;
  if (frontend) state.frontendName = frontend;

  // Auth check at boot — same shape as the Codex backend's `none`
  // path, just simpler (no auth.json file flow; OpenAI Agents SDK
  // wants OPENAI_API_KEY from env or constructor option).
  const apiKey = process.env.OPENAI_API_KEY ?? cfg.openaiApiKey ?? undefined;
  if (apiKey) {
    const source = process.env.OPENAI_API_KEY
      ? "env:OPENAI_API_KEY"
      : "config:openaiApiKey";
    log("agent", `OpenAI Agents auth: api-key (source: ${source})`);
  } else {
    logWarn(
      "agent",
      "OpenAI Agents: no OPENAI_API_KEY env, no openaiApiKey in talon.json — " +
        "first turn will fail. Set OPENAI_API_KEY or add openaiApiKey to talon.json.",
    );
  }
}

/**
 * Get the OpenAI API key Talon should use for the Agents SDK.
 *
 * Priority: `OPENAI_API_KEY` env > `openaiApiKey` in Talon config >
 * `undefined`. The SDK reads `OPENAI_API_KEY` from env on its own
 * (via the `openai` package's default client) — we still surface
 * config-based keys here so the handler can pass them explicitly to
 * the model constructor.
 */
export function getOpenAIApiKey(): string | undefined {
  const state = getState();
  return process.env.OPENAI_API_KEY ?? state.config?.openaiApiKey ?? undefined;
}

/**
 * Return the list of frontends that need an MCP tool server spawned.
 * `terminal` is excluded — there's no outbound messaging surface for
 * the terminal frontend.
 */
export function getActiveFrontends(): readonly string[] {
  const state = getState();
  const fe = state.config?.frontend;
  if (!fe) return [];
  const all = Array.isArray(fe) ? fe : [fe];
  return all.filter((f) => f !== "terminal");
}
