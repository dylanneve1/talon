/**
 * `whatsapp:*` callbacks — the /whatsapp panel's buttons.
 *
 *   whatsapp:pair     run one bounded pairing attempt
 *   whatsapp:refresh  re-read link state and redraw the panel
 */

import type { Context } from "grammy";
import {
  runWhatsAppPairing,
  whatsAppPanel,
} from "../commands/whatsapp-pairing.js";
import { isAuthorizedAdmin } from "../commands/state.js";
import { answerCallbackQuerySafe } from "./query.js";

export async function handleWhatsAppCallback(
  ctx: Context,
  data: string,
): Promise<void> {
  if (!isAuthorizedAdmin(ctx)) {
    await answerCallbackQuerySafe(ctx, { text: "Not authorized." });
    return;
  }
  const [, action] = data.split(":");

  if (action === "refresh") {
    await answerCallbackQuerySafe(ctx);
    const panel = whatsAppPanel();
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (chatId === undefined || messageId === undefined) return;
    await ctx.api
      .editMessageText(chatId, messageId, panel.text, {
        parse_mode: "HTML",
        ...(panel.keyboard.length
          ? { reply_markup: { inline_keyboard: panel.keyboard } }
          : {}),
      })
      .catch(() => {});
    return;
  }

  if (action === "pair") {
    await answerCallbackQuerySafe(ctx, { text: "Starting pairing…" });
    await runWhatsAppPairing(ctx);
    return;
  }

  await answerCallbackQuerySafe(ctx, { text: "Invalid callback data" });
}
