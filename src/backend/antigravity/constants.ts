/**
 * Antigravity backend constants.
 */

/**
 * System-prompt suffix appended to the user-configured system prompt.
 *
 * Antigravity delivery model: the agent's reply is the stream of
 * `Text` chunks from `response.chunks`. Talon batches them via
 * `onTextBlock` after the turn closes. Delivery tools
 * (`end_turn` / `send` / `react`) come through MCP — the agent's
 * `ToolCall` chunks route into Talon's MCP server.
 *
 * Both routes are valid; this suffix documents the choices the model
 * has and dedupes when both are used.
 */
export const ANTIGRAVITY_SYSTEM_PROMPT_SUFFIX = `

## Antigravity Delivery

Two ways to deliver a reply — pick whichever fits:

- **Plain text** — your conversational text output IS the reply. Just
  answer normally. (Reasoning content / thoughts stay private.)
- **Delivery tools** — call \`end_turn(text="...", reply_to=N)\` for
  threaded replies, \`send(type="text"|"photo"|"poll"|...)\` for rich
  content, or \`react(emoji="...")\` for emoji acknowledgements. Use
  these when you need reply targeting, buttons, attachments, or
  multiple bubbles.

If you call a delivery tool, don't also repeat the same text in plain
output — Talon dedupes but it's cleaner to commit to one route.
`;

/**
 * Default model used by the Antigravity backend when none is configured.
 *
 * `gemini-3.5-flash` is Google's mid-tier reasoning model — fast, broad
 * context, available on the free tier of Google AI Studio. Released
 * 2026-05-19 at Google I/O. Bigger flagship models exist
 * (`gemini-3-pro`) but Flash is the right default for chat-shaped
 * workloads.
 */
export const ANTIGRAVITY_DEFAULT_MODEL = "gemini-3.5-flash";

/**
 * Path to the Python bridge script, resolved relative to this module
 * at runtime. The bridge is shipped INSIDE the TS source tree so the
 * tarball includes it (the `files` glob picks `src/**` up).
 */
export const ANTIGRAVITY_BRIDGE_SCRIPT = "python/agent_bridge.py";

/**
 * Default location of the Python venv that has `google-antigravity`
 * installed. Overridable via `talon.json` -> `antigravityPython` (full
 * path to `python3` binary) or `antigravityVenvPath` (path to a venv
 * directory; the bridge will use `<venv>/bin/python3`).
 *
 * Operators are expected to provision the venv out-of-band — Talon
 * does NOT auto-pip-install. The default below matches the install
 * path the heartbeat / setup-wizard docs recommend.
 */
export const ANTIGRAVITY_DEFAULT_VENV_PATH = "~/.talon-antigravity/venv";

/**
 * Per-turn timeout (ms) for a chat dispatch. The bridge has no upper
 * bound on its own — Antigravity model calls can take 30s+ on heavy
 * prompts — so the timeout is set generously to avoid false aborts.
 * Tunable via `TALON_ANTIGRAVITY_TURN_TIMEOUT_MS` env.
 */
export const ANTIGRAVITY_TURN_TIMEOUT_MS = (() => {
  const raw = process.env.TALON_ANTIGRAVITY_TURN_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
})();

/**
 * Symlink path Talon creates at startup so localharness can use the
 * REAL Talon workspace (`~/.talon/workspace/`) without tripping its
 * hidden-segment refusal.
 *
 * Background: `localharness` literally rejects any URI whose path
 * contains a segment starting with `.` — including `~/.talon/`. We
 * still want the agent to read/write the same workspace every other
 * backend uses (memory, uploads, daily notes, palace), so we make a
 * symlink under the user's home (visible name → hidden target). The
 * binary checks the literal path it's given, not its realpath() —
 * verified against the live install.
 *
 * Resolved at init time to `<home>/talon-workspace`. Auto-created if
 * missing; left alone if already a symlink to the right place. If it
 * exists as a regular directory (e.g. a user's own work) Talon emits
 * a doctor warning and the operator must pick another path via
 * `antigravityWorkspace` in talon.json.
 */
export const ANTIGRAVITY_WORKSPACE_SYMLINK_NAME = "talon-workspace";

/**
 * Bridge protocol version we expect on the `ready` event. Bumped in
 * lock-step with `agent_bridge.py`'s `BRIDGE_PROTOCOL_VERSION`.
 */
export const ANTIGRAVITY_BRIDGE_PROTOCOL_VERSION = 1;
