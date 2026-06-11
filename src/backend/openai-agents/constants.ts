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

import { buildDeliveryContract } from "../shared/delivery-contract.js";

/**
 * Agents-specific addendum to the shared tool-only delivery contract:
 * this backend namespaces every MCP tool, so the contract's bare tool
 * names need a mapping note.
 */
const OPENAI_AGENTS_NAMESPACING_NOTE = `
### Tool namespacing on this backend

Every MCP tool is prefixed with \`mcp_<serverName>__\` so collisions
across plugins are impossible — e.g. the delivery tools above appear
as \`mcp_<frontend>-tools__end_turn\`, \`mcp_<frontend>-tools__send\`,
\`mcp_<frontend>-tools__react\` (\`mcp_telegram-tools__end_turn\` on
Telegram, \`mcp_discord-tools__end_turn\` on Discord). The
available-tools list you receive at turn start has the authoritative
names; use them verbatim. Built-in tools (Read, Write, Edit, Bash,
Glob, Grep) are NOT prefixed — they stay short.

If you produce trailing prose AND call \`end_turn(text=...)\` with
the same text, the handler dedupes; you're not punished for being
careful, but the tool call is the source of truth.
`;

/**
 * Build the system-prompt suffix for a frontend: the shared tool-only
 * delivery contract (single source of truth, same text claude-sdk
 * appends) plus the namespacing addendum above.
 *
 * The openai-agents handler enforces strict tool-only delivery —
 * trailing prose is private scratchpad and is NEVER shipped to the
 * user as a fallback. A prose-only turn triggers one [FLOW VIOLATION]
 * reminder retry; a second violation accepts a silent drop. The
 * suffix tells the model that up front so it doesn't have to discover
 * it via the reminder.
 */
export function buildOpenAiAgentsSuffix(frontend: string): string {
  return `\n\n${buildDeliveryContract("tool-only", frontend)}\n${OPENAI_AGENTS_NAMESPACING_NOTE}`;
}

/**
 * Telegram-shaped default suffix. Prefer `buildOpenAiAgentsSuffix`
 * with the active frontend; this constant exists for the public
 * barrel export and tests.
 */
export const OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX =
  buildOpenAiAgentsSuffix("telegram");

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
