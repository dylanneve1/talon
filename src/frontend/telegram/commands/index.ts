/**
 * All /command handlers for the Telegram bot.
 *
 * Split by category:
 *   - `definitions` — the TELEGRAM_COMMANDS menu (single source of truth)
 *   - `state`       — shared admin-id holder + admin guard
 *   - `info`        — /start /help /ping /plugins
 *   - `session`     — /reset /status
 *   - `settings`    — /model /effort /pulse /settings
 *   - `admin`       — /admin /metrics /doctor /dream /soul /restart /update
 *                     + the unknown-command suggester
 *
 * `registerCommands` wires every group onto the bot, preserving the original
 * registration order (info → session → settings → admin, with the
 * unknown-command catch-all registered last).
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../../util/config.js";
import type { Backend } from "../../../core/agent-runtime/capabilities.js";
import { registerInfoCommands } from "./info.js";
import { registerSessionCommands } from "./session.js";
import { registerSettingsCommands } from "./settings.js";
import { registerAdminCommands } from "./admin.js";

export { TELEGRAM_COMMANDS } from "./definitions.js";
export { setAdminUserId } from "./state.js";

export function registerCommands(
  bot: Bot,
  config: TalonConfig,
  gateway?: { backend: Backend | null },
): void {
  const deps = { config, gateway };
  registerInfoCommands(bot);
  registerSessionCommands(bot, deps);
  registerSettingsCommands(bot, deps);
  registerAdminCommands(bot, deps);
}
