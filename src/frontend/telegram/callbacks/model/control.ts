/**
 * `model:done` / `model:noop` / unparseable — ack-only callbacks. Nothing
 * to redraw; each answers the query itself.
 */

import type { Context } from "grammy";
import { answerCallbackQuerySafe } from "../query.js";
import type { ModelOutcome } from "./types.js";

// Acknowledge fast (within Telegram's 30s window) so the user
// doesn't see a perpetual loading spinner.
export async function handleDone(
  ctx: Context,
): Promise<ModelOutcome | undefined> {
  await answerCallbackQuerySafe(ctx, { text: "Done" });
  try {
    await ctx.deleteMessage();
  } catch {
    /* might lack delete permission */
  }
  return undefined;
}

export async function handleNoop(
  ctx: Context,
): Promise<ModelOutcome | undefined> {
  await answerCallbackQuerySafe(ctx);
  return undefined;
}
