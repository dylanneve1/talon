/**
 * Discord slash commands — equivalent to src/frontend/telegram/commands.
 *
 * Split by responsibility (mirrors the telegram commands/ layout):
 *   - `definitions` — SlashCommandBuilder defs + per-guild/global registration
 *   - `shared`      — reply / chatId helpers used by every handler
 *   - `router`      — the interactionCreate listener + slash-command dispatch
 *   - `info`        — /start /help /ping /plugins
 *   - `session`     — /reset /status
 *   - `settings`    — /model /effort /pulse /settings
 *   - `admin`       — /restart /metrics /dream /admin
 *
 * Slash command surface mirrors Telegram: /start /help /settings
 * /status /ping /model /effort /pulse /reset /restart /metrics /dream /plugins
 * /admin <subcommand>.
 */

export { registerCommandsForGuilds } from "./definitions.js";
export { registerInteractionRouter } from "./router.js";
