/**
 * In-memory history queries — only used when a richer userbot-backed
 * implementation isn't available. Frontends may override these.
 */

import {
  getRecentFormatted,
  searchHistory,
  getMessagesByUser,
  getKnownUsers,
} from "../../../storage/history.js";
import { formatMediaIndex } from "../../../storage/media-index.js";
import type { SharedActionHandlers } from "./types.js";

export const historyHandlers: SharedActionHandlers = {
  read_history: (body, chatId) => {
    const limit = Math.min(100, Number(body.limit ?? 30));
    return { ok: true, text: getRecentFormatted(String(chatId), limit) };
  },

  search_history: (body, chatId) => {
    const limit = Math.min(100, Number(body.limit ?? 20));
    return {
      ok: true,
      text: searchHistory(String(chatId), String(body.query ?? ""), limit),
    };
  },

  get_user_messages: (body, chatId) => {
    const limit = Math.min(50, Number(body.limit ?? 20));
    return {
      ok: true,
      text: getMessagesByUser(
        String(chatId),
        String(body.user_name ?? ""),
        limit,
      ),
    };
  },

  list_known_users: (body, chatId) => ({
    ok: true,
    text: getKnownUsers(String(chatId)),
  }),

  list_media: (body, chatId) => ({
    ok: true,
    text: formatMediaIndex(
      String(chatId),
      Math.min(20, Number(body.limit ?? 10)),
    ),
  }),
};
