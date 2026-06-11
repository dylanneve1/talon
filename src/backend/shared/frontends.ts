/**
 * Frontend-list helpers shared across backends.
 *
 * Every backend needs "which frontends get an MCP tool server?" at
 * spawn time; before this helper, claude-sdk, openai-agents, and codex
 * each carried their own copy of the same normalise-and-filter logic.
 */

/**
 * Normalise a config `frontend` value (string or array, possibly
 * undefined) to the list of messaging frontends — i.e. those that
 * need an MCP tool server spawned. `terminal` is excluded: it has no
 * outbound messaging surface (the agent runs to stdout).
 */
export function nonTerminalFrontends(
  frontend: string | readonly string[] | undefined,
): readonly string[] {
  if (!frontend) return [];
  const all = Array.isArray(frontend) ? frontend : [frontend as string];
  return all.filter((f) => f !== "terminal");
}
