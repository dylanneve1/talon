/**
 * Agy backend constants.
 *
 * `agy` is Google's Antigravity CLI binary (~/.local/bin/agy by default),
 * auto-authenticated via the OAuth token at
 * `~/.gemini/antigravity-cli/antigravity-oauth-token`. No API key needed —
 * the binary uses whatever account `agy login` was last run against.
 */

/** Display label surfaced in `/status` and the model picker. */
export const AGY_LABEL = "Agy (local OAuth)";

/**
 * Default location of the agy binary. Resolved on Talon startup via $PATH
 * lookup first; this fallback only kicks in if `which agy` fails.
 */
export const AGY_DEFAULT_BINARY = "agy";

/**
 * Hard cap on agy --print invocations. Overridable per-deployment via
 * config (future). 5 minutes matches agy's own --print-timeout default.
 */
export const AGY_PRINT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Default model the agy CLI reports — agy doesn't expose a model flag
 * in --print mode (it uses whatever the user last selected
 * interactively), so this is a label, not a controllable knob.
 */
export const AGY_DEFAULT_MODEL = "agy-default";
