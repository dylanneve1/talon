/**
 * Live-tier test bot wiring.
 *
 * Constructs a real grammy `Bot` against the test token plus a minimal
 * `Gateway` stub satisfying the `incrementMessages` surface the production
 * action handler depends on. Returns the Talon `createTelegramActionHandler`
 * action dispatcher bound to the live API.
 *
 * Tests then call the dispatcher with action bodies and verify side effects
 * by reading messages back via the same Bot's `bot.api.*` calls.
 *
 * NOT booted as a long-running process — no polling, no `bot.start()`. We
 * only use `bot.api` for outbound calls and direct API for read-back.
 */

import { Bot, InputFile } from "grammy";
import { createTelegramActionHandler } from "../../../frontend/telegram/actions/index.js";
import type { Gateway } from "../../../core/engine/gateway.js";

export interface TestBotEnv {
  bot: Bot;
  /** Action dispatcher with the same signature as production. */
  dispatch: (
    body: Record<string, unknown>,
    chatId: number,
  ) => ReturnType<ReturnType<typeof createTelegramActionHandler>>;
  /** Counter incremented every time the gateway stub's `incrementMessages` fires. */
  getSentCount: () => number;
}

/**
 * Build a fresh test-bot environment. Cheap — no network calls until the
 * test invokes an action.
 */
export function makeTestBot(botToken: string): TestBotEnv {
  const bot = new Bot(botToken);

  let sentCount = 0;
  const gatewayStub = {
    incrementMessages: () => {
      sentCount += 1;
    },
  } as unknown as Gateway;

  const dispatch = createTelegramActionHandler(
    bot,
    InputFile,
    botToken,
    gatewayStub,
  );

  return {
    bot,
    dispatch,
    getSentCount: () => sentCount,
  };
}

/**
 * Convenience: read a message back via the Bot API. Used by tests to
 * verify a sent message landed.
 *
 * Telegram's Bot API doesn't expose a direct "get message by id" — the
 * closest is `forwardMessage` to a different chat (which mutates state
 * and fires extra side effects). We use `editMessageText` with the same
 * text as a no-op verification: if the message exists, the edit succeeds
 * (with "message is not modified" being treated as success).
 *
 * For richer round-trips, prefer using grammy's `bot.api.getChat` or
 * forwarding to a sandbox chat. Keep tests limited to messages we just
 * sent in the same suite to avoid hitting historical state.
 */
export async function messageExists(
  bot: Bot,
  chatId: number,
  messageId: number,
): Promise<boolean> {
  try {
    // Editing reply-markup with empty markup is a cheap probe — succeeds if
    // the message is reachable + bot owns it; fails with descriptive errors
    // if the message is gone.
    await bot.api.editMessageReplyMarkup(chatId, messageId, {});
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Telegram returns "Bad Request: message is not modified" when the markup
    // is already empty — that's still a "message exists" signal.
    if (msg.includes("message is not modified")) return true;
    // "message to edit not found" is the real "doesn't exist" path.
    if (msg.includes("message to edit not found")) return false;
    // Anything else: surface as not-found defensively (test will fail loud).
    return false;
  }
}
