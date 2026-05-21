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
 * API-key billing is present (`CODEX_API_KEY`, `TALON_CODEX_KEY`,
 * `codexApiKey`, or a last-resort generic OpenAI key). The
 * `gpt-5-codex` model is the highest-quality coding model available
 * through Codex on OpenAI's native endpoint but requires API-key
 * billing — it is not granted to ChatGPT subscription accounts.
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

/**
 * ThreadOptions permission settings shared by both the chat handler and
 * the heartbeat/dream one-shot path.
 *
 * Talon runs Codex with full permissions — `approvalPolicy: "never"`,
 * `sandboxMode: "danger-full-access"`, and `networkAccessEnabled: true`.
 * Codex is non-interactive in this harness (no UI to surface approval
 * prompts on), and Talon already trusts every other backend (Claude SDK,
 * OpenAI Agents, Kilo, OpenCode, Antigravity) with the same level of
 * access — `bypassPermissions` + `allowDangerouslySkipPermissions: true`
 * is the equivalent in the Claude SDK backend. Restricting Codex more
 * tightly than its sibling backends would just produce silent failures
 * on shell / file / network tool calls without changing the security
 * model: the bot-user identity (claudiusthebot, isolated VPS account,
 * no credentials to user-level data) is the actual security boundary.
 *
 *   - `approvalPolicy: "never"`         — Codex never asks for approval
 *                                         on its native commands
 *                                         (bash, apply_patch, etc).
 *   - `sandboxMode: "danger-full-access"` — full disk + network access
 *                                         inside Codex's sandbox.
 *   - `networkAccessEnabled: true`      — explicit, in case Codex ever
 *                                         defaults the boolean.
 *
 * MCP tool calls have their own approval surface (`AppToolApproval`
 * enum, `default_tools_approval_mode` per server) which Talon also
 * sets to `"approve"` in `mcp-config.ts`.
 */
export const CODEX_THREAD_PERMISSIONS = {
  approvalPolicy: "never" as const,
  sandboxMode: "danger-full-access" as const,
  networkAccessEnabled: true,
} satisfies {
  approvalPolicy: "never";
  sandboxMode: "danger-full-access";
  networkAccessEnabled: boolean;
};
