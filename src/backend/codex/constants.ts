/**
 * Codex backend constants.
 */

/**
 * System-prompt suffix appended to the user-configured system prompt.
 *
 * Codex delivery model: the agent's reply comes back as `agent_message`
 * thread items + `thread.runStreamed` events. Talon ships the final
 * `agent_message` content via `onTextBlock` after the turn closes.
 * Delivery tools (`end_turn` / `send` / `react`) work via MCP — the
 * agent's `mcp_tool_call` items route through Talon's MCP server.
 *
 * Both routes are valid; the suffix below documents the model's
 * choices.
 */
export const CODEX_SYSTEM_PROMPT_SUFFIX = `

## Codex Delivery

Two ways to deliver a reply — pick whichever fits:

- **Plain text** — your agent_message text is the reply. Just answer
  normally. (Reasoning content stays private.)
- **Delivery tools** — call \`end_turn(text="...", reply_to=N)\` for
  threaded replies, \`send(type="text"|"photo"|"poll"|...)\` for rich
  content, or \`react(emoji="...")\` for emoji acknowledgements. Use
  these when you need reply targeting, buttons, attachments, or
  multiple bubbles.

If you call a delivery tool, don't also repeat the same text in plain
output — Talon dedupes but it's cleaner to commit to one route.
`;

/**
 * Default model used by the Codex backend when none is configured AND
 * an API key is present (`OPENAI_API_KEY` env or `openaiApiKey` in
 * config). The `gpt-5-codex` model is the highest-quality coding model
 * available through the Codex CLI but requires API-key billing — it is
 * not granted to ChatGPT subscription accounts.
 */
export const CODEX_DEFAULT_MODEL = "gpt-5-codex";

/**
 * Default model used by the Codex backend when the user is signed in
 * via ChatGPT OAuth (`~/.codex/auth.json` `auth_mode: "chatgpt"`).
 * The `gpt-5-codex` model is rejected with a 400
 * `invalid_request_error` ("not supported when using Codex with a
 * ChatGPT account") on this auth path; `gpt-5.5` is the supported
 * flagship for ChatGPT users.
 */
export const CODEX_CHATGPT_DEFAULT_MODEL = "gpt-5.5";

/**
 * Set of Codex models that require an API key (i.e. won't work under
 * ChatGPT OAuth). Used by the handler's recovery ladder to detect a
 * model-not-supported error and automatically fall back to a
 * chatgpt-compatible model on retry.
 *
 * Keep this list in sync with `CODEX_MODELS` in `models.ts` — every
 * entry there with `apiKeyOnly: true` should appear here.
 */
export const CODEX_API_KEY_ONLY_MODELS: ReadonlySet<string> = new Set([
  "gpt-5-codex",
]);

/**
 * Default working directory for thread runs. Codex enforces a git-repo
 * check by default; we set `skipGitRepoCheck: true` and use a known
 * directory under the user's Talon workspace.
 */
export const CODEX_DEFAULT_WORKING_DIRECTORY =
  process.env.HOME ?? process.cwd();
