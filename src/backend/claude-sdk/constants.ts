/**
 * Claude SDK backend constants — thinking effort, streaming, and
 * chat-specific tool whitelist.
 *
 * Core whitelist lives in core/constants.ts (kept separate so the chat
 * additions live next to the rest of the chat-handler config).
 */

import {
  ALLOWED_TOOLS_CORE,
  ALLOWED_TOOLS_BACKGROUND,
} from "../../core/constants.js";

// Re-export so existing backend imports keep working
export { ALLOWED_TOOLS_CORE, ALLOWED_TOOLS_BACKGROUND };

/**
 * Whitelist of built-in tools available to the main chat handler.
 *
 * Chat gets two extras on top of the core whitelist:
 * - `Agent`: sub-agent dispatch (Explore / Plan / etc.). Useful for
 *   focused subtasks like code-review or codebase audits; the heartbeat
 *   path keeps it out because nested agents complicate orphan tracking.
 * - `Skill`: required for `/skill` commands and other skill-driven flows.
 *   The SDK auto-includes Skill when `skills` are passed via options, but
 *   we list it explicitly so the tool surface is unambiguous from a single
 *   constants file.
 */
export const ALLOWED_TOOLS_CHAT = [
  ...ALLOWED_TOOLS_CORE,
  "Agent",
  "Skill",
] as const;

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
