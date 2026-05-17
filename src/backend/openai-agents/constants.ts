/**
 * OpenAI Agents backend constants.
 *
 * The OpenAI Agents SDK (`@openai/agents`) is the official Node SDK
 * for OpenAI's Responses API + agent framework. It speaks directly to
 * OpenAI's API (billed via `OPENAI_API_KEY`) — distinct from the
 * Codex backend which delegates to the `codex` CLI subprocess.
 *
 * Talon uses it as a single-agent backend (no handoffs, no agent
 * orchestration) with MCP servers wired from the plugin system.
 *
 * OpenRouter compatibility: when `openrouterApiKey` / OPENROUTER_API_KEY
 * is configured, `initOpenAIAgentsAgent` redirects the SDK's default
 * client to `OPENAI_AGENTS_OPENROUTER_BASE_URL`. Any model ID that
 * OpenRouter accepts (e.g. `meta-llama/llama-3.3-70b-instruct`) can
 * then be set via `model` in talon.json.
 */

/**
 * System-prompt suffix appended to the user-configured system prompt.
 *
 * Mirrors the codex backend's suffix shape — documents the two delivery
 * routes (plain text via agent_message vs explicit delivery tools).
 */
export const OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX = `

## OpenAI Agents Delivery

Two ways to deliver a reply — pick whichever fits:

- **Plain text** — your final response text is the reply. Just answer
  normally.
- **Delivery tools** — call \`end_turn(text="...", reply_to=N)\` for
  threaded replies, \`send(type="text"|"photo"|"poll"|...)\` for rich
  content, or \`react(emoji="...")\` for emoji acknowledgements.

If you call a delivery tool, don't also repeat the same text in plain
output — Talon dedupes but it's cleaner to commit to one route.
`;

/**
 * Default model used by the OpenAI Agents backend when none is
 * configured. The Agents SDK speaks to the Responses API which
 * supports the standard `gpt-5*` family; `gpt-5.5` is the broadest-
 * access flagship that most billing accounts have.
 *
 * When routing through OpenRouter (`openrouterApiKey` set), override
 * this via `model` in talon.json — e.g.
 * `meta-llama/llama-3.3-70b-instruct` for the best free-tier
 * general-purpose option, or `deepseek/deepseek-v4-flash` for a
 * reasoning-capable free model.
 */
export const OPENAI_AGENTS_DEFAULT_MODEL = "gpt-5.5";

/**
 * Maximum number of agent loop turns per `run()` call. The Agents SDK
 * runs an internal loop (model → tool calls → model → ...) until
 * either a final output is produced or this limit is hit. Talon's
 * conversations don't need deep multi-step reasoning loops — the chat
 * is the conversation — so we cap reasonably to bound runaway tool-
 * call cascades.
 */
export const OPENAI_AGENTS_MAX_TURNS = 50;

/** Default agent name surfaced in OpenAI traces / observability. */
export const OPENAI_AGENTS_AGENT_NAME = "Talon";

/**
 * Default base URL when routing through OpenRouter.
 *
 * OpenRouter exposes an OpenAI-compatible `/v1` API, so the Agents SDK
 * works without code changes — only the client's base URL and API key
 * need to change. Override via `openrouterBaseUrl` in talon.json for
 * custom OpenAI-compatible deployments (Azure OpenAI, local Ollama
 * proxy, etc.).
 */
export const OPENAI_AGENTS_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
