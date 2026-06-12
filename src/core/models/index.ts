/**
 * Model layer — everything about "which model is the chat using".
 *
 *   - `catalog`          — model-id resolution, defaults, and the
 *     curated cross-backend catalog.
 *   - `active-model`     — per-chat active-model resolution
 *     (chat-settings → config → backend default).
 *   - `reasoning-levels` — the reasoning-effort vocabulary shared by
 *     every backend (order, labels, normalisation).
 *
 * Presentation helpers (menus, status lines) live in `frontend/` —
 * this layer is pure domain.
 */

export * from "./catalog.js";
export * from "./active-model.js";
export * from "./reasoning-levels.js";
