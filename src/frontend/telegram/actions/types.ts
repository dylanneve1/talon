/**
 * Telegram action-handler types.
 *
 * Each domain module exports a `TelegramActionHandlers` map keyed by action
 * name. Handlers receive the request body, the numeric chat id, and a shared
 * `TelegramActionContext` carrying the bound bot, the InputFile constructor,
 * the bot token, the gateway, and the per-handler `scheduledMessages` timers.
 */

import type { Bot, InputFile as GrammyInputFile } from "grammy";
import type { Gateway } from "../../../core/engine/gateway.js";
import type { ActionResult } from "../../../core/types.js";

export interface TelegramActionContext {
  bot: Bot;
  InputFileClass: typeof GrammyInputFile;
  botToken: string;
  gateway: Gateway;
  /** Active scheduled-message timers, keyed by schedule id (for cancellation). */
  scheduledMessages: Map<string, ReturnType<typeof setTimeout>>;
}

export type TelegramActionHandler = (
  body: Record<string, unknown>,
  chatId: number,
  ctx: TelegramActionContext,
) => Promise<ActionResult | null> | ActionResult | null;

export type TelegramActionHandlers = Record<string, TelegramActionHandler>;

export const TELEGRAM_MAX_TEXT = 4096;
