/**
 * Forum-topic ops — create / edit / close / reopen / delete.
 */

import type { Bot } from "grammy";
import { toPositiveId } from "../shared.js";
import type { ModerationOp, ModerationOps } from "./types.js";

/** An op on an existing topic: validates `thread_id`, then runs `call`. */
function topicOp(
  call: (
    api: Bot["api"],
    chatId: number,
    threadId: number,
    body: Record<string, unknown>,
  ) => Promise<unknown>,
): ModerationOp {
  return async ({ op, body, chatId, ctx: { bot } }) => {
    const threadId = toPositiveId(body.thread_id);
    if (threadId === undefined)
      return { ok: false, error: `${op}: thread_id required` };
    await call(bot.api, chatId, threadId, body);
    return { ok: true };
  };
}

export const topicOps: ModerationOps = {
  create_topic: async ({ body, chatId, ctx: { bot } }) => {
    if (!body.title)
      return { ok: false, error: "create_topic: title required" };
    const topic = await bot.api.createForumTopic(chatId, String(body.title));
    return { ok: true, thread_id: topic.message_thread_id };
  },
  edit_topic: topicOp((api, chatId, threadId, body) =>
    api.editForumTopic(chatId, threadId, {
      name: body.title ? String(body.title) : undefined,
    }),
  ),
  close_topic: topicOp((api, chatId, threadId) =>
    api.closeForumTopic(chatId, threadId),
  ),
  reopen_topic: topicOp((api, chatId, threadId) =>
    api.reopenForumTopic(chatId, threadId),
  ),
  delete_topic: topicOp((api, chatId, threadId) =>
    api.deleteForumTopic(chatId, threadId),
  ),
};
