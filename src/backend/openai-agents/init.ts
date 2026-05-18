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
 * exposes three knobs, each resolvable from a Talon-specific env var
 * or `talon.json` (env wins):
 *
 *   key:      TALON_AGENTS_KEY      > config.openaiApiKey
 *   baseURL:  TALON_AGENTS_URL      > config.openaiBaseUrl
 *   apiMode:  TALON_AGENTS_API_MODE > config.openaiApiMode
 *
 * Talon deliberately ignores the OpenAI-standard `OPENAI_API_KEY` /
 * `OPENAI_BASE_URL` / `OPENAI_API_MODE` env vars: operators frequently
 * have those exported for other tools (e.g. an OpenAI dev key in
 * their shell rc) and pointing Talon at a different endpoint would
 * otherwise conflict silently. Set the `TALON_AGENTS_*` aliases or
 * put the values in `~/.talon/config.json`.
 *
 *   - baseURL — redirects the SDK at any OpenAI-compatible service.
 *   - apiMode — "responses" (OpenAI native) or "chat_completions"
 *       (most third parties). When a custom baseURL is set and mode is
 *       unset, defaults to "chat_completions" because most non-OpenAI
 *       endpoints don't implement Responses.
 *
 * With no key resolved Talon emits a startup warning; first turn
 * fails with an auth error.
 *
 * The SDK's `setDefaultOpenAIClient()` is global — all subsequent
 * `new Agent({...})` instances inherit the redirect.
 */

import OpenAI from "openai";
import { setDefaultOpenAIClient, setOpenAIAPI } from "@openai/agents";
import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../registry.js";
import { log, logWarn, logDebug } from "../../util/log.js";
import { getState, type EndpointModelCapabilities } from "./state.js";

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

  // Resolve endpoint configuration. Talon-specific env vars only, so
  // an unrelated `OPENAI_API_KEY` (or `OPENAI_BASE_URL`) exported in
  // the operator's shell — common when they also use OpenAI directly
  // for other tools — can't silently override what's in `talon.json`.
  //   key:      TALON_AGENTS_KEY      > config.openaiApiKey
  //   baseURL:  TALON_AGENTS_URL      > config.openaiBaseUrl
  //   apiMode:  TALON_AGENTS_API_MODE > config.openaiApiMode
  const keyEnv = process.env.TALON_AGENTS_KEY
    ? { value: process.env.TALON_AGENTS_KEY, source: "env:TALON_AGENTS_KEY" }
    : cfg.openaiApiKey
      ? { value: cfg.openaiApiKey, source: "config:openaiApiKey" }
      : { value: undefined, source: "none" };
  const apiKey = keyEnv.value;

  const urlEnv = process.env.TALON_AGENTS_URL
    ? { value: process.env.TALON_AGENTS_URL, source: "env:TALON_AGENTS_URL" }
    : cfg.openaiBaseUrl
      ? { value: cfg.openaiBaseUrl, source: "config:openaiBaseUrl" }
      : { value: undefined, source: "default (api.openai.com)" };
  const baseURL = urlEnv.value;

  const envMode = process.env.TALON_AGENTS_API_MODE;
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

    const urlSourceWithValue = baseURL
      ? `${urlEnv.source} (${baseURL})`
      : urlEnv.source;

    log(
      "agent",
      `OpenAI Agents auth: key=${keyEnv.source} baseURL=${urlSourceWithValue} api=${resolvedApiMode}`,
    );

    if (!apiKey) {
      logWarn(
        "agent",
        "OpenAI Agents: custom baseURL is set but no API key was provided. " +
          "If your endpoint requires auth, first turn will fail. Set " +
          "TALON_AGENTS_KEY or openaiApiKey in talon.json.",
      );
    }
  } else {
    logWarn(
      "agent",
      "OpenAI Agents: no TALON_AGENTS_KEY env and no openaiApiKey in talon.json — " +
        "first turn will fail. Set one of these to enable the backend.",
    );
  }

  // Fire-and-forget: enrich the in-memory model catalog with whatever
  // the remote endpoint advertises via `GET /models`. Lets /status,
  // /settings, and the model picker show real context windows for
  // any OpenAI-compatible endpoint (OpenRouter, Ollama, LiteLLM,
  // vLLM, Azure with deployments) without Talon having to maintain a
  // per-provider catalog. No-op for the default OpenAI endpoint —
  // its /models response doesn't include `context_length`, so the
  // built-in OPENAI_AGENTS_MODELS catalog stays authoritative there.
  if (baseURL) {
    fetchEndpointModels(baseURL, apiKey).catch((err) => {
      logDebug(
        "agent",
        `Endpoint model enrichment skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}

// ── Endpoint model enrichment ───────────────────────────────────────────────

interface EndpointModelEntry {
  id?: string;
  name?: string;
  context_length?: number;
  top_provider?: { context_length?: number };
  pricing?: { prompt?: string | number; completion?: string | number };
}

/**
 * Query the OpenAI-compatible `/models` endpoint and stash the
 * advertised model metadata (context window, display name, free
 * flag) into `state.endpointModels`. Called once at backend init.
 *
 * Designed to be tolerant: the spec is loose enough that endpoints
 * shape responses differently (OpenRouter has `top_provider.context_length`
 * and `pricing.prompt`, vLLM has just `context_length`, Ollama has
 * neither). We grab whatever's present and ignore the rest.
 */
async function fetchEndpointModels(
  baseURL: string,
  apiKey: string | undefined,
): Promise<void> {
  const url = baseURL.replace(/\/+$/, "") + "/models";
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`/models returned ${res.status}`);
  }
  const json = (await res.json()) as { data?: EndpointModelEntry[] };
  const data = Array.isArray(json?.data) ? json.data : [];

  const state = getState();
  let enriched = 0;
  for (const entry of data) {
    if (!entry || typeof entry.id !== "string") continue;
    const caps: EndpointModelCapabilities = {};
    const ctx =
      typeof entry.context_length === "number"
        ? entry.context_length
        : typeof entry.top_provider?.context_length === "number"
          ? entry.top_provider.context_length
          : undefined;
    if (ctx && ctx > 0) caps.contextWindow = ctx;
    if (typeof entry.name === "string" && entry.name)
      caps.displayName = entry.name;
    const promptPrice = entry.pricing?.prompt;
    if (
      promptPrice !== undefined &&
      (promptPrice === "0" || promptPrice === 0)
    ) {
      caps.free = true;
    }
    if (Object.keys(caps).length === 0) continue;
    state.endpointModels.set(entry.id, caps);
    enriched += 1;
  }

  log("agent", `OpenAI Agents: enriched ${enriched} models from ${url}`);
}

/**
 * Get the OpenAI API key Talon should use for the Agents SDK.
 *
 * Priority: `TALON_AGENTS_KEY` env > `openaiApiKey` in Talon config >
 * `undefined`. Talon ignores the generic `OPENAI_API_KEY` env var to
 * avoid silent conflicts with operators who export it for other tools.
 */
export function getOpenAIApiKey(): string | undefined {
  const state = getState();
  return (
    process.env.TALON_AGENTS_KEY ?? state.config?.openaiApiKey ?? undefined
  );
}

/**
 * Get the configured OpenAI-compatible base URL, if any. Returns
 * `undefined` when targeting OpenAI's production API directly.
 *
 * Priority: `TALON_AGENTS_URL` env > `openaiBaseUrl` in Talon config >
 * `undefined`. Talon ignores `OPENAI_BASE_URL` for the same reason it
 * ignores `OPENAI_API_KEY`.
 */
export function getOpenAIBaseUrl(): string | undefined {
  const state = getState();
  return (
    process.env.TALON_AGENTS_URL ?? state.config?.openaiBaseUrl ?? undefined
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
