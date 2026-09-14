/**
 * Discord interaction callbacks — components, modals, and autocomplete.
 *
 * Mirrors src/frontend/telegram/callbacks. Split by interaction kind:
 *   - components/  — button + select-menu router, a dispatch table keyed by
 *                    custom-id prefix with one handler module per prefix
 *                    (settings/pulse/effort/model/metrics + ai: forwarding)
 *   - modals       — modal submissions (pulse interval)
 *   - autocomplete — /model name autocomplete with a cached model list
 */

export { handleComponentInteraction } from "./components/index.js";
export { handleModalSubmit } from "./modals.js";
export { handleAutocomplete } from "./autocomplete.js";
