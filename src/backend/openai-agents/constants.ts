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
- **Delivery tools** — call the namespaced delivery tool for the active
  frontend: \`mcp_<frontend>-tools__end_turn(text="...", reply_to=N)\`
  for threaded replies, \`mcp_<frontend>-tools__send(...)\` for rich
  content (photos, polls, voice, scheduled messages),
  \`mcp_<frontend>-tools__react(emoji="...")\` for emoji
  acknowledgements. Substitute \`<frontend>\` with the active frontend
  ID — e.g. \`mcp_telegram-tools__end_turn\` on Telegram,
  \`mcp_discord-tools__end_turn\` on Discord.

### Why tools are namespaced

This backend prefixes every MCP tool with \`mcp_<serverName>__\` so
collisions across plugins are impossible — Telegram's
\`cancel_scheduled\` (scheduled message) and the email plugin's
\`cancel_scheduled\` (scheduled email) coexist as
\`mcp_telegram-tools__cancel_scheduled\` and
\`mcp_email-tools__cancel_scheduled\`. The available-tools list you
receive at turn start has the authoritative names; use them verbatim.
Built-in tools (Read, Write, Edit, Bash, Glob, Grep) are NOT
prefixed — they stay short.

If you call a delivery tool, don't also repeat the same text in plain
output — Talon dedupes but it's cleaner to commit to one route.
`;

/**
 * Default model used by the OpenAI Agents backend when none is
 * configured. The Agents SDK speaks to the Responses API which
 * supports the standard `gpt-5*` family; `gpt-5.5` is the broadest-
 * access flagship that most billing accounts have.
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
