/**
 * Shared callback helpers + the dependency bundle passed to each handler.
 */

import type { Context } from "grammy";
import type { TalonConfig } from "../../../util/config.js";
import type { Backend } from "../../../core/agent-runtime/capabilities.js";
import { logWarn } from "../../../util/log.js";
import type { SettingsButton } from "../helpers/index.js";

export type CallbackDeps = {
  config: TalonConfig;
  gateway?: { backend: Backend | null };
};

/**
 * Wrapper around `editMessageText` that swallows Telegram's
 * "message is not modified" noise (we hit it whenever a user
 * taps a button that doesn't actually change the rendered state)
 * while still surfacing real failures to the operator log. Without
 * this distinction, buttons silently fail to update and the symptom
 * is "I clicked X and nothing happened".
 */
export async function editOrIgnoreSame(
  ctx: Context,
  text: string,
  inlineKeyboard: Array<Array<SettingsButton>>,
): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/message is not modified/i.test(msg)) return;
    logWarn("bot", `editMessageText failed: ${msg}`);
  }
}

/**
 * Wrapper around `answerCallbackQuery` that swallows Telegram's
 * "query is too old / query ID is invalid" error. Telegram invalidates
 * callback queries after ~15s; any handler whose pre-answer work runs
 * longer (model resolution against an upstream API, backend rebind,
 * SDK init, etc.) will throw an unhandled GrammyError when it finally
 * tries to dismiss the spinner. The query is genuinely dead at that
 * point — there is nothing useful to do beyond logging it so we can
 * spot slow paths. Other failures still surface to the operator log.
 */
export async function answerCallbackQuerySafe(
  ctx: Context,
  other?: Parameters<Context["answerCallbackQuery"]>[0],
): Promise<void> {
  try {
    if (other === undefined) {
      await ctx.answerCallbackQuery();
    } else {
      await ctx.answerCallbackQuery(other);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /query is too old|query id is invalid|response timeout expired/i.test(msg)
    ) {
      logWarn("bot", `answerCallbackQuery skipped — callback expired: ${msg}`);
      return;
    }
    logWarn("bot", `answerCallbackQuery failed: ${msg}`);
  }
}
