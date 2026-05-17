/**
 * OpenAI Agents backend initialisation.
 *
 * No long-running server, no per-chat instance cache — the SDK is
 * stateless from Talon's side. We only capture config + frontend +
 * gateway-port resolver at init, plus surface an auth-mode log line
 * so operators know whether `OPENAI_API_KEY` (or `OPENROUTER_API_KEY`)
 * actually resolves.
 *
 * OpenRouter: if `openrouterApiKey` or `OPENROUTER_API_KEY` env is set,
 * a custom `OpenAI` client is injected via `setDefaultOpenAIClient()`.
 * The Agents SDK picks this up globally — no handler changes needed.
 * Set `model` in talon.json to any OpenRouter model ID, e.g.:
 *   "meta-llama/llama-3.3-70b-instruct"  ← best free-tier general pick
 *   "deepseek/deepseek-v4-flash"          ← free, reasoning-capable
 */

import OpenAI from "openai";
import { setDefaultOpenAIClient } from "@openai/agents";
import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../registry.js";
import { log, logWarn } from "../../util/log.js";
import { getState } from "./state.js";
import { OPENAI_AGENTS_OPENROUTER_BASE_URL } from "./constants.js";

/**
 * Initialise the OpenAI Agents backend.
 *
 * Auth priority (first match wins):
 *   1. OPENROUTER_API_KEY env / config.openrouterApiKey
 *      → custom OpenAI client pointed at OpenRouter; no OpenAI key needed
 *   2. OPENAI_API_KEY env / config.openaiApiKey
 *      → SDK's built-in default client (direct OpenAI billing)
 *   3. Neither set
 *      → startup warning; first turn will fail with an auth error
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

  // ── OpenRouter redirect ─────────────────────────────────────────────────
  // If an OpenRouter API key is configured, point the Agents SDK's default
  // client at OpenRouter's OpenAI-compatible endpoint. This enables free-
  // tier models (e.g. `meta-llama/llama-3.3-70b-instruct`) without direct
  // OpenAI billing. Set `model` in talon.json to the desired OpenRouter
  // model ID; `gpt-5.5` (the openai-agents default) won't resolve there.
  const openrouterKey =
    process.env.OPENROUTER_API_KEY ?? cfg.openrouterApiKey ?? undefined;
  if (openrouterKey) {
    const baseURL =
      cfg.openrouterBaseUrl ?? OPENAI_AGENTS_OPENROUTER_BASE_URL;
    const client = new OpenAI({ apiKey: openrouterKey, baseURL });
    setDefaultOpenAIClient(client);
    const source = process.env.OPENROUTER_API_KEY
      ? "env:OPENROUTER_API_KEY"
      : "config:openrouterApiKey";
    log(
      "agent",
      `OpenAI Agents auth: openrouter (source: ${source}, baseUrl: ${baseURL})`,
    );
    return;
  }

  // ── Direct OpenAI API ───────────────────────────────────────────────────
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
 *
 * Note: returns `undefined` when OpenRouter is configured
 * (`openrouterApiKey` / `OPENROUTER_API_KEY`). In that case the SDK
 * uses the custom client injected by `initOpenAIAgentsAgent`.
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
