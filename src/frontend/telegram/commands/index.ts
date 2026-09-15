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
 * `registerCommands` wires every group onto the bot in an order that ends
 * with `admin`, because admin owns the unknown-command catch-all and that
 * must be the last handler to see a bare /command.
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../../util/config.js";
import type { Backend } from "../../../core/agent-runtime/capabilities.js";
import { registerInfoCommands } from "./info.js";
import { registerSessionCommands } from "./session.js";
import { registerSettingsCommands } from "./settings.js";
import { registerAdminCommands } from "./admin.js";
import { registerWhatsAppPairingCommand } from "./whatsapp-pairing.js";
import { registerAuthCommand } from "./auth.js";

export { telegramCommandMenu } from "./definitions.js";
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
  registerWhatsAppPairingCommand(bot);
  registerAuthCommand(bot);
  // admin LAST: it owns the unknown-command catch-all, which must only
  // be reached after every real command has had its chance to match.
  // Registering anything after it makes that command look unknown
  // ("Unknown command /whatsapp — did you mean /whatsapp?").
  registerAdminCommands(bot, deps);
}
