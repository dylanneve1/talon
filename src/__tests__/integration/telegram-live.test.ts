/**
 * Live-tier integration tests against the real Telegram Bot API.
 *
 * Tests Talon's external boundary — does `createTelegramActionHandler`
 * actually produce valid Telegram API calls, do `send_message`, `react`,
 * `edit_message`, `delete_message` round-trip end-to-end against the
 * real api.telegram.org.
 *
 * Skipped by default. Opt in by either:
 *   - Setting `TALON_TEST_BOT_TOKEN` + `TALON_TEST_CHAT_ID` in the env, or
 *   - Populating `~/.config/talon-tests/secrets.env` with the same keys.
 *
 * Tests are written to clean up after themselves: every message sent in a
 * test is deleted in an `afterEach`. A test chat with rolling history is
 * fine — there's no expectation of pristine state.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadLiveSecrets,
  describeMissingSecrets,
} from "./telegram-live/secrets-loader.js";
import { makeTestBot, messageExists } from "./telegram-live/test-bot.js";

const skipReason = describeMissingSecrets();
const secrets = loadLiveSecrets();

// Per-test cleanup tracker — every test pushes message IDs it created here.
const sentMessageIds: number[] = [];

describe.skipIf(skipReason !== null)("Telegram live integration", () => {
  let env: ReturnType<typeof makeTestBot>;
  let chatId: number;

  beforeAll(() => {
    if (!secrets.botToken || !secrets.chatId) {
      throw new Error("Unreachable: skipIf should have caught this.");
    }
    env = makeTestBot(secrets.botToken);
    chatId = secrets.chatId;
  });

  afterEach(async () => {
    // Best-effort cleanup: delete everything we sent.
    while (sentMessageIds.length) {
      const msgId = sentMessageIds.shift()!;
      try {
        await env.bot.api.deleteMessage(chatId, msgId);
      } catch {
        /* already deleted or out of window — ignore */
      }
    }
  });

  it("getMe — bot token authenticates", async () => {
    const me = await env.bot.api.getMe();
    expect(me.is_bot).toBe(true);
    expect(typeof me.username).toBe("string");
    expect(me.username!.length).toBeGreaterThan(0);
  }, 15000);

  it("send_message — produces a valid message with the expected text", async () => {
    const text = `talon-live-test-${Date.now()}`;
    const result = await env.dispatch({ action: "send_message", text }, chatId);
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    const msgId = result?.message_id as number;
    expect(typeof msgId).toBe("number");
    sentMessageIds.push(msgId);

    // Verify the message landed in the chat.
    expect(await messageExists(env.bot, chatId, msgId)).toBe(true);
  }, 15000);

  it("react — adds an emoji reaction to a sent message", async () => {
    const seed = await env.dispatch(
      { action: "send_message", text: "react-target" },
      chatId,
    );
    const targetId = seed?.message_id as number;
    sentMessageIds.push(targetId);

    const result = await env.dispatch(
      { action: "react", message_id: targetId, emoji: "👍" },
      chatId,
    );
    expect(result?.ok).toBe(true);
  }, 15000);

  it("edit_message — updates message content in place", async () => {
    const seed = await env.dispatch(
      { action: "send_message", text: "edit-original" },
      chatId,
    );
    const targetId = seed?.message_id as number;
    sentMessageIds.push(targetId);

    const newText = `edit-updated-${Date.now()}`;
    const result = await env.dispatch(
      { action: "edit_message", message_id: targetId, text: newText },
      chatId,
    );
    expect(result?.ok).toBe(true);
  }, 15000);

  it("delete_message — removes a sent message from the chat", async () => {
    const seed = await env.dispatch(
      { action: "send_message", text: "delete-target" },
      chatId,
    );
    const targetId = seed?.message_id as number;

    const result = await env.dispatch(
      { action: "delete_message", message_id: targetId },
      chatId,
    );
    expect(result?.ok).toBe(true);

    // After deletion the message should be gone (don't push to cleanup tracker).
    expect(await messageExists(env.bot, chatId, targetId)).toBe(false);
  }, 15000);

  it("send_message_with_buttons — sends inline keyboard", async () => {
    const result = await env.dispatch(
      {
        action: "send_message_with_buttons",
        text: "live test buttons",
        buttons: [
          [{ text: "A", callback_data: "a" }],
          [{ text: "B", callback_data: "b" }],
        ],
      },
      chatId,
    );
    expect(result?.ok).toBe(true);
    const msgId = result?.message_id as number;
    sentMessageIds.push(msgId);
  }, 15000);

  it("dispatcher reports send count via the gateway stub", async () => {
    const before = env.getSentCount();
    await env.dispatch(
      { action: "send_message", text: "counter probe" },
      chatId,
    );
    const after = env.getSentCount();
    sentMessageIds.push(0); // the result wasn't captured here; cleanup will no-op
    expect(after - before).toBeGreaterThanOrEqual(1);
  }, 15000);
});
