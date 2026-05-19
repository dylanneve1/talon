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
 * The openai-agents handler enforces a strict tool-only delivery
 * contract — same as claude-sdk. Trailing prose is private scratchpad
 * and is NEVER shipped to the user as a fallback. Replies must reach
 * the chat through a delivery tool call. A turn that produces only
 * prose triggers one [FLOW VIOLATION] reminder retry; a second
 * violation accepts a silent drop. This suffix tells the model that
 * up front so it doesn't have to discover it via the reminder.
 */
export const OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX = `

## Reply contract — tool-only delivery

Your output stream (the prose you produce alongside tool calls) is
PRIVATE scratchpad. The user never sees it. The ONLY way text reaches
the user is through a delivery tool call:

- **Delivery tools** — call the namespaced delivery tool for the active
  frontend. Substitute \`<frontend>\` with the active frontend ID —
  e.g. \`mcp_telegram-tools__end_turn\` on Telegram,
  \`mcp_discord-tools__end_turn\` on Discord.
  - \`mcp_<frontend>-tools__end_turn(text="...", reply_to=N)\` —
    canonical final reply. Optional \`reply_to\` for threaded replies,
    optional \`buttons\` for inline keyboards.
  - \`mcp_<frontend>-tools__end_turn()\` (no args) — explicit silent
    close after you've done something (e.g. just reacted with an
    emoji) and have nothing else to say. Use this rather than
    producing prose-with-no-tool.
  - \`mcp_<frontend>-tools__send(type="text"|"photo"|"poll"|"voice"|...)\`
    — mid-turn rich content. Does NOT close the turn — typically
    followed by another \`send(...)\` and finally an
    \`end_turn(...)\` / \`end_turn()\`.
  - \`mcp_<frontend>-tools__react(message_id, emoji)\` — emoji
    reaction. Often the right response to acknowledge without
    replying. Pair with \`end_turn()\` to close cleanly.

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

**There is no plain-text fallback.** If you write a thoughtful reply
in your output stream and forget to wrap it in a tool call, the
handler will re-prompt you ONCE with a \`[FLOW VIOLATION]\` reminder.
A second miss in the same turn drops the prose silently. To save
the user a round-trip of latency, ALWAYS call a delivery tool —
don't talk first and ask "did you get that?" second.

If you produce trailing prose AND call \`end_turn(text=...)\` with
the same text, the handler dedupes; you're not punished for being
careful, but the tool call is the source of truth.
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
