/**
 * `pulse:*` callbacks — toggle the conversation pulse and re-render the panel.
 */

import type { Context } from "grammy";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
} from "../../../core/background/pulse.js";
import { answerCallbackQuerySafe } from "./shared.js";

export async function handlePulseCallback(
  ctx: Context,
  data: string,
  cid: string,
): Promise<void> {
  const val = data.slice(6);
  if (val === "on") {
    enablePulse(cid);
    registerChat(cid);
    await answerCallbackQuerySafe(ctx, { text: "Pulse: on" });
  } else if (val === "off") {
    disablePulse(cid);
    await answerCallbackQuerySafe(ctx, { text: "Pulse: off" });
  }
  const enabled = isPulseEnabled(cid);
  try {
    await ctx.editMessageText(
      `<b>🔔 Pulse:</b> ${enabled ? "on" : "off"}\n\nReads along every few minutes and jumps in when there's something to add.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: enabled ? "✓ On" : "On", callback_data: "pulse:on" },
              {
                text: !enabled ? "✓ Off" : "Off",
                callback_data: "pulse:off",
              },
            ],
          ],
        },
      },
    );
  } catch {
    /* unchanged */
  }
}
