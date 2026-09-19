/**
 * Antigravity (`agy`) backend constants.
 *
 * The CLI is Google's Antigravity agent driven in headless mode
 * (`docs/agy/headless-docs.md`). Talon keeps one long-lived
 * `--input-format stream-json` child per chat and feeds it one
 * `user` event per turn; everything below is the vocabulary that
 * child is spawned and framed with.
 */

import { buildDeliveryContract } from "../runtime/prompt/delivery-contract.js";

/**
 * System-prompt suffix appended to the user-configured system prompt.
 *
 * agy has no system-prompt flag at all, so the assembled prompt rides
 * in as a fenced block on the FIRST turn of a conversation (see
 * `handler/message.ts`); resumed conversations inherit it from their
 * stored history. The contract itself is the shared text-or-tools one:
 * agy streams `text_delta` for prose AND routes Talon's delivery tools
 * through MCP, so both delivery routes are live.
 *
 * Tool names are frontend-specific (native's send tool is
 * `send_message`, telegram's is `send`), so the suffix is built per
 * chat from the chat's owning frontend.
 */
export function agySystemPromptSuffix(frontend: string): string {
  return `\n\n${buildDeliveryContract("text-or-tools", frontend)}\n`;
}

/** Telegram-shaped default, kept for the one-shot path and tests. */
export const AGY_SYSTEM_PROMPT_SUFFIX = agySystemPromptSuffix("telegram");

/**
 * Default model when none is configured.
 *
 * `agy models` lists Gemini, Claude and GPT-OSS slugs; the Flash-High
 * Gemini is the subscription-backed default the interactive CLI uses
 * and the only one guaranteed present on a consumer account.
 */
export const AGY_DEFAULT_MODEL = "gemini-3.8-flash-high";

/** Minimum `agy --version` the backend is known to work against. */
export const AGY_MIN_VERSION = "1.2.0";

/**
 * Prefix every MCP server entry Talon writes into agy's shared
 * `mcp_config.json` carries. Anything under this prefix is ours to
 * add, rewrite and delete; anything else in that file belongs to the
 * user and is preserved byte-for-byte.
 */
export const AGY_MCP_PREFIX = "__talon__";

/**
 * How long a per-chat child may sit idle before it is reaped. A warm
 * child costs a few hundred MB of resident Go process; 10 minutes
 * matches the MCP hub's own child TTL so a conversation that goes
 * quiet releases both at roughly the same time.
 */
export const AGY_IDLE_REAP_MS = 10 * 60 * 1000;

/** Grace between SIGTERM and SIGKILL when tearing a child down. */
export const AGY_KILL_GRACE_MS = 2000;

/**
 * Fixed CLI flags every headless child is spawned with.
 *
 *   - `--input-format stream-json`  — many turns in one process; each
 *     `user` line on stdin runs one turn and yields one `result`.
 *   - `--output-format stream-json` — required by the input format,
 *     and the only shape that reports tools and usage live.
 *   - `--dangerously-skip-permissions` — headless means no operator to
 *     approve a tool; without it every shell/file call is soft-denied
 *     with a stderr notice and the turn quietly does nothing. Same
 *     posture as every other Talon backend (see
 *     `codex/constants.ts: CODEX_THREAD_PERMISSIONS`).
 *   - `--print-timeout 0s`          — no ceiling on a turn; Talon owns
 *     turn timeouts, not the CLI.
 */
export const AGY_BASE_ARGS: readonly string[] = [
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--dangerously-skip-permissions",
  "--print-timeout",
  "0s",
];
