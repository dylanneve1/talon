/**
 * /auth — backend login panel (admin only). Also captures the code an
 * admin replies with during a Claude sign-in, before the message reaches
 * the agent.
 */

import type { Bot } from "grammy";
import type { LoginBinaries } from "../../../core/auth/login-flow.js";
import {
  currentAuthPanel,
  pendingCodePrompt,
  submitPendingCode,
} from "../auth-panel.js";
import { isAuthorizedAdmin, type RegisterDeps } from "./state.js";

export function loginBinariesFrom(
  config: RegisterDeps["config"],
): LoginBinaries {
  return {
    claude: config.claudeBinary,
    codex: process.env.TALON_CODEX_BINARY || config.codexBinary,
  };
}

export function registerAuthCommand(bot: Bot): void {
  bot.command("auth", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    const panel = await currentAuthPanel();
    await ctx.reply(panel.text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: panel.keyboard },
    });
  });

  // A reply to the sign-in prompt carries the pasted code. Only admins,
  // only while a flow is waiting, only as a reply to that exact message —
  // anything else falls through to the normal pipeline untouched.
  bot.on("message:text", async (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const pending = pendingCodePrompt(chatId);
    if (
      !pending ||
      !isAuthorizedAdmin(ctx) ||
      ctx.message.reply_to_message?.message_id !== pending.messageId
    ) {
      await next();
      return;
    }
    if (submitPendingCode(chatId, ctx.message.text)) {
      await ctx.reply("Got it — finishing sign-in…");
      return;
    }
    await next();
  });
}
