/**
 * Sub-agent context vocabulary — the one place that knows what an
 * `agent:<id>` context label looks like.
 *
 * A one-shot run carries a `contextLabel` (`OneShotAgentParams`) that every
 * layer downstream keys on: the backend picks the MCP server set from it, the
 * MCP hub binds a tool session to it, and the bridge sends it back to the
 * gateway as `_chatId`. A sub-agent's label is `agent:<id>`, which is how the
 * gateway recognises a tool call as coming from that agent rather than from a
 * chat.
 *
 * Deliberately a dependency-free leaf: `backend/claude-sdk` and
 * `core/engine/gateway` both import it, and routing either through
 * `core/agents/index.ts` (which pulls in the runner, and with it the backend
 * pool) would close an import cycle.
 */

/** Prefix of every sub-agent context label / chat key. */
export const AGENT_CONTEXT_PREFIX = "agent:";

/** The context label a sub-agent's one-shot run (and its tools) is bound to. */
export function agentContextLabel(agentId: string): string {
  return `${AGENT_CONTEXT_PREFIX}${agentId}`;
}

/** The agent id inside a context label, or null when it isn't one. */
export function agentIdFromContextLabel(label: string): string | null {
  if (!label.startsWith(AGENT_CONTEXT_PREFIX)) return null;
  const id = label.slice(AGENT_CONTEXT_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * Whether a context label denotes a background run that gets the full
 * cross-surface tool set: frontend tools (outbound with an explicit
 * `chat_id`) plus every loaded plugin.
 *
 * Two labels qualify: `heartbeat` (also reused by isolated cron/trigger jobs,
 * see `background/cron/job-prompt.ts`) and any `agent:<id>` sub-agent run.
 * `dream` deliberately does not — it is a memory-consolidation pass with no
 * business messaging anyone.
 */
export function isBackgroundToolContext(contextLabel: string): boolean {
  return (
    contextLabel === "heartbeat" ||
    agentIdFromContextLabel(contextLabel) !== null
  );
}
