/**
 * Shared constants for background agents (dream, heartbeat).
 *
 * These tool restriction lists are backend-agnostic — they describe
 * interactive or planning-only tools that make no sense in a headless
 * agent context, regardless of which AI backend is active.
 */

/** Interactive/planning tools disallowed in all headless agent contexts. */
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

/** Disallowed tools for background agents — dream and heartbeat (core + Agent). */
export const DISALLOWED_TOOLS_BACKGROUND = [
  ...DISALLOWED_TOOLS_CORE,
  "Agent",
] as const;
