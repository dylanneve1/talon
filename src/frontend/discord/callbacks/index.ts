/**
 * Discord interaction callbacks — components, modals, and autocomplete.
 *
 * Mirrors src/frontend/telegram/callbacks. Split by interaction kind:
 *   - shared       — ComponentInteraction type + chatIdFromInteraction
 *   - components   — button + select-menu handler (settings/pulse/effort/model
 *                    + ai: forwarding), refreshSettingsPanel, forwardToAgent
 *   - modals       — modal submissions (pulse interval)
 *   - autocomplete — /model name autocomplete with a cached model list
 */

export { handleComponentInteraction } from "./components.js";
export { handleModalSubmit } from "./modals.js";
export { handleAutocomplete } from "./autocomplete.js";
