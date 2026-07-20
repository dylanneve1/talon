/**
 * Reasoning-effort vocabulary — a dependency-free primitive shared by
 * every layer (storage persists it, core resolves it, backends map it
 * to provider knobs, frontends render pickers over it).
 *
 * Lives in src/types/ (a leaf: imports nothing from src/) so the layers
 * below core/ can name the type without importing upward. core/types.ts
 * re-exports it for the engine-side importers.
 */

export type ReasoningEffortLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "max" | "xhigh";
