/**
 * OpenAI Agents backend initialisation.
 *
 * No long-running server, no per-chat instance cache — the SDK is
 * stateless from Talon's side. We only capture config + frontend +
 * gateway-port resolver at init, plus surface an auth-mode log line
 * so operators know whether `OPENAI_API_KEY` (or a custom-endpoint
 * configuration) actually resolves.
 *
 * Endpoint selection
 * ──────────────────
 *
 * The `@openai/agents` SDK targets OpenAI's API by default but accepts
 * any OpenAI-compatible endpoint via a custom `OpenAI` client. Talon
 * exposes this through two config fields (or env vars):
 *
 *   - `openaiBaseUrl` / `OPENAI_BASE_URL`
 *       Redirects the SDK at any OpenAI-compatible service —
 *       OpenRouter, Azure OpenAI, local Ollama, LiteLLM, etc.
 *   - `openaiApiMode` / `OPENAI_API_MODE`
 *       Which OpenAI API surface to target. "responses" (OpenAI native)
 *       or "chat_completions" (most third parties). When `openaiBaseUrl`
 *       is set and the mode is unset, defaults to "chat_completions"
 *       because most non-OpenAI endpoints don't implement Responses.
 *
 * Auth priority (first match wins):
 *
 *   1. `OPENAI_API_KEY` env / `config.openaiApiKey`
 *      → injected client (custom baseURL if configured, OpenAI default
 *        otherwise). Required for any non-trivial setup.
 *   2. No key set
 *      → startup warning; first turn fails with an auth error.
 *
 * The SDK's `setDefaultOpenAIClient()` is global — all subsequent
 * `new Agent({...})` instances inherit the redirect.
 */

import OpenAI from "openai";
import { setDefaultOpenAIClient, setOpenAIAPI } from "@openai/agents";
import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../registry.js";
import { log, logWarn } from "../../util/log.js";
import { getState } from "./state.js";

/**
 * Initialise the OpenAI Agents backend.
 *
 * Records config + frontend, then wires the SDK's default client and
 * API surface based on resolved endpoint/key/mode. No turns fire here;
 * the actual agent loop runs in `handler.ts`.
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

  // Resolve endpoint configuration. Env vars take precedence over
  // talon.json so operators can override per-invocation without
  // editing config.
  const apiKey = process.env.OPENAI_API_KEY ?? cfg.openaiApiKey ?? undefined;
  const baseURL = process.env.OPENAI_BASE_URL ?? cfg.openaiBaseUrl ?? undefined;

  const envMode = process.env.OPENAI_API_MODE;
  const resolvedApiMode: "responses" | "chat_completions" =
    envMode === "chat_completions" || envMode === "responses"
      ? envMode
      : (cfg.openaiApiMode ??
        // When a custom baseURL is set, default to chat_completions —
        // most third-party endpoints (OpenRouter, Ollama, LiteLLM, most
        // Azure deployments) only implement Chat Completions. Operators
        // can opt back into Responses explicitly if their proxy
        // supports it.
        (baseURL ? "chat_completions" : "responses"));

  // Apply API-surface toggle. Cheap; safe to call unconditionally so
  // the log line below accurately reflects what subsequent `run()`
  // calls will use.
  setOpenAIAPI(resolvedApiMode);

  // Inject a custom OpenAI client when we have a key, a baseURL, or
  // both. Without either we leave the SDK's default in place (so a
  // bare `OPENAI_API_KEY` set later still works) — the warning below
  // covers the empty case.
  if (apiKey || baseURL) {
    const client = new OpenAI({
      // OpenAI client requires *some* apiKey, even for endpoints that
      // ignore auth (some local Ollama setups). Placeholder if missing.
      apiKey: apiKey ?? "missing-key",
      ...(baseURL ? { baseURL } : {}),
    });
    setDefaultOpenAIClient(client);

    const keySource = process.env.OPENAI_API_KEY
      ? "env:OPENAI_API_KEY"
      : cfg.openaiApiKey
        ? "config:openaiApiKey"
        : "none";
    const urlSource = process.env.OPENAI_BASE_URL
      ? `env:OPENAI_BASE_URL (${baseURL})`
      : cfg.openaiBaseUrl
        ? `config:openaiBaseUrl (${baseURL})`
        : "default (api.openai.com)";

    log(
      "agent",
      `OpenAI Agents auth: key=${keySource} baseURL=${urlSource} api=${resolvedApiMode}`,
    );

    if (!apiKey) {
      logWarn(
        "agent",
        "OpenAI Agents: custom baseURL is set but no API key was provided. " +
          "If your endpoint requires auth, first turn will fail. Set OPENAI_API_KEY " +
          "or openaiApiKey in talon.json.",
      );
    }
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
 * Get the configured OpenAI-compatible base URL, if any. Returns
 * `undefined` when targeting OpenAI's production API directly.
 */
export function getOpenAIBaseUrl(): string | undefined {
  const state = getState();
  return (
    process.env.OPENAI_BASE_URL ?? state.config?.openaiBaseUrl ?? undefined
  );
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
