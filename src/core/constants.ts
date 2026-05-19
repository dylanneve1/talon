/**
 * Shared constants for the Claude Agent SDK backend (chat + background agents).
 *
 * These define the WHITELIST of built-in tools the SDK is allowed to expose
 * to the model. The model can never call a tool that isn't in the relevant
 * list — newly-introduced SDK built-ins (e.g. Monitor, PushNotification,
 * RemoteTrigger added in the deferred-tools surface) stay disabled by
 * default until explicitly opted in here.
 *
 * Whitelist > blacklist for SDK tools: the upstream tool surface grows over
 * time, and silently inheriting new tools is exactly the failure mode a
 * blacklist invites. The model also still has all of Talon's MCP servers
 * (telegram-tools, brave-search, mempalace, github, playwright, etc.) — those
 * are MCP-side tools, not SDK built-ins, and are governed independently.
 *
 * These constants are Claude-SDK-specific. Other backends (Kilo, OpenCode,
 * Codex, OpenAI Agents) drive tool exposure through their own SDK options.
 */

/**
 * Core whitelist — file I/O, shell, search, MCP resource access, and the
 * deferred-tool loader. Sufficient for every headless agent context.
 *
 * Notable omissions and why:
 * - `WebSearch` / `WebFetch`: replaced by Brave Search MCP (richer output,
 *   no per-tool rate limits, accessible to non-SDK backends).
 * - `TodoRead`/`TodoWrite`, `EnterPlanMode`/`ExitPlanMode`,
 *   `EnterWorktree`/`ExitWorktree`, `TaskCreate`/`TaskUpdate`/`TaskGet`/
 *   `TaskList`/`TaskOutput`/`TaskStop`: interactive/Plan-mode tooling that
 *   doesn't apply to a server-side bot.
 * - `AskUserQuestion`: there's no interactive user to ask — Talon either
 *   replies via MCP or doesn't.
 * - `ScheduleWakeup`: /loop-skill-only; wedged the dispatcher for 35 minutes
 *   on 2026-04-27 when called outside /loop mode (talon.log [e2589f7e]).
 * - `Monitor`, `PushNotification`, `RemoteTrigger`: notification/automation
 *   primitives Talon implements server-side via its own trigger system and
 *   the gateway. Allowing the SDK versions creates two parallel automation
 *   surfaces with different lifecycle guarantees.
 */
export const ALLOWED_TOOLS_CORE = [
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "Glob",
  "Grep",
  "ToolSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
] as const;

/**
 * Background agents (dream, heartbeat) — core plus `Skill` (some skills are
 * still useful in headless flows, e.g. `/loop` cadence control).
 *
 * Notably NO `Agent`: nested sub-agent dispatch from inside a
 * heartbeat/dream pass complicates lifecycle tracking and burns the model's
 * thinking budget on context the parent already had.
 */
export const ALLOWED_TOOLS_BACKGROUND = [
  ...ALLOWED_TOOLS_CORE,
  "Skill",
] as const;
