/**
 * Claude SDK backend constants — thinking effort, streaming, and
 * chat-specific tool restrictions.
 *
 * Core disallowed-tool lists live in core/constants.ts (backend-agnostic).
 */

import {
  DISALLOWED_TOOLS_CORE,
  DISALLOWED_TOOLS_BACKGROUND,
} from "../../core/constants.js";

// Re-export so existing backend imports keep working
export { DISALLOWED_TOOLS_CORE, DISALLOWED_TOOLS_BACKGROUND };

/** Disallowed tools for the main chat handler (core + web tools replaced by Brave MCP). */
export const DISALLOWED_TOOLS_CHAT = [
  ...DISALLOWED_TOOLS_CORE,
  "WebSearch",
  "WebFetch",
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
