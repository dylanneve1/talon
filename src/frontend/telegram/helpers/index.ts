/**
 * Shared helpers used by commands, callbacks, and the settings panel.
 *
 *   - `format`      — interval parsing, duration/token/bytes formatting,
 *                     model-label/option helpers
 *   - `diagnostics` — metrics + doctor HTML rendering
 *   - `menu`        — settings/model/backend keyboards, effort rows, the
 *                     model-menu state builder + its types
 */

export * from "./format.js";
export * from "./diagnostics.js";
export * from "./menu.js";
