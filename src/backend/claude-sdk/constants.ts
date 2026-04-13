/**
 * Shared constants for Claude SDK backend and background agents.
 *
 * Single source of truth for disallowed tool lists, thinking effort
 * configuration, and streaming parameters.
 */

// ── Disallowed tool lists ──────────────────────────────────────────────────

/**
 * Core tools disallowed in all SDK query contexts (chat, heartbeat, dream).
 * These are interactive or planning-only tools that make no sense in a
 * headless agent context.
 */
export const DISALLOWED_TOOLS_CORE = [
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "TodoWrite",
  "TodoRead",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "AskUserQuestion",
] as const;

/** Disallowed tools for the main chat handler (core + web tools replaced by Brave MCP). */
export const DISALLOWED_TOOLS_CHAT: string[] = [
  ...DISALLOWED_TOOLS_CORE,
  "WebSearch",
  "WebFetch",
];

/** Disallowed tools for background agents — heartbeat and dream (core + Agent). */
export const DISALLOWED_TOOLS_BACKGROUND: string[] = [
  ...DISALLOWED_TOOLS_CORE,
  "Agent",
];

// ── Thinking / effort configuration ────────────────────────────────────────

export const EFFORT_MAP: Record<
  string,
  {
    thinking: { type: "adaptive" | "disabled" };
    effort?: "low" | "medium" | "high" | "max";
  }
> = {
  off: { thinking: { type: "disabled" } },
  low: { thinking: { type: "adaptive" }, effort: "low" },
  medium: { thinking: { type: "adaptive" }, effort: "medium" },
  high: { thinking: { type: "adaptive" }, effort: "high" },
  max: { thinking: { type: "adaptive" }, effort: "max" },
};

// ── Streaming ──────────────────────────────────────────────────────────────

/** Minimum interval (ms) between streaming delta callbacks to avoid flooding frontends. */
export const STREAM_INTERVAL = 1000;
