/**
 * All callback_query handlers (settings panel, model/effort selectors,
 * pulse toggle).
 *
 * Split by callback-data prefix:
 *   - `shared`   — editOrIgnoreSame + answerCallbackQuerySafe + deps type
 *   - `settings` — `settings:*` (effort/proactive + stale-picker handling)
 *   - `pulse`    — `pulse:*`
 *   - `effort`   — `effort:*`
 *   - `model`    — `model:*` (menu / backend / browse controller)
 *
 * `registerCallbacks` installs one `callback_query:data` listener that
 * dispatches on the data prefix, preserving the original order and the
 * fall-through to the agent backend for unrecognized callbacks.
 */

import type { Bot } from "grammy";
import type { TalonConfig } from "../../../util/config.js";
import type { Backend } from "../../../core/agent-runtime/capabilities.js";
import { handleCallbackQuery } from "../handlers/index.js";
import type { CallbackDeps } from "./shared.js";
import { handleSettingsCallback } from "./settings.js";
import { handlePulseCallback } from "./pulse.js";
import { handleEffortCallback } from "./effort.js";
import { handleModelCallback } from "./model.js";

export { answerCallbackQuerySafe } from "./shared.js";

export function registerCallbacks(
  bot: Bot,
  config: TalonConfig,
  gateway?: { backend: Backend | null },
): void {
  const deps: CallbackDeps = { config, gateway };

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const cid = String(ctx.chat?.id ?? ctx.from?.id);

    // Handle /settings callbacks (effort, pulse, done). Model selection
    // is intentionally NOT here — that lives entirely under /model now.
    if (data.startsWith("settings:")) {
      await handleSettingsCallback(ctx, data, cid, deps);
      return;
    }

    // Handle pulse callbacks
    if (data.startsWith("pulse:")) {
      await handlePulseCallback(ctx, data, cid);
      return;
    }

    // Handle effort callbacks
    if (data.startsWith("effort:")) {
      await handleEffortCallback(ctx, data, cid, deps);
      return;
    }

    // Handle /model callbacks via the pure parser + menu controller.
    if (data.startsWith("model:")) {
      await handleModelCallback(ctx, data, cid, deps);
      return;
    }

    // Forward other callbacks to the AI backend
    handleCallbackQuery(ctx, bot, config);
  });
}
