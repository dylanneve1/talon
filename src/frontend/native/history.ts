/**
 * History pages + search — persisted rows re-hydrated into the wire shape
 * (attached images get a fresh /media URL, assistant rows their turn meta).
 */

import {
  getRecentHistory,
  getHistoryBefore,
  searchHistoryMessages,
  type HistoryMessage,
} from "../../storage/history.js";
import { isDeliveryTool } from "../../core/tools/index.js";
import type { ChatEntry } from "./chats.js";
import { refreshContext } from "./context.js";
import { mediaUrl, registerMedia } from "./media.js";
import {
  historyToClientMessage,
  type ClientMessage,
  type SearchResult,
} from "./protocol.js";
import type { NativeRuntime } from "./runtime.js";
import { getTurnMeta } from "./turn-meta.js";

export type HistoryPageOptions = { before?: number; limit?: number };

function hydrateHistoryRow(
  runtime: NativeRuntime,
  chatId: string,
  row: HistoryMessage,
): ClientMessage {
  const msg = historyToClientMessage(row, chatId);
  // Re-hydrate an attached image: re-register its on-disk path into
  // the media map and hand back a fresh /media URL so the image shows
  // in reloaded history (survives restarts as long as the file exists).
  if (row.mediaType === "photo" && row.filePath) {
    msg.imagePath = mediaUrl(registerMedia(runtime, row.filePath));
  }
  // Re-hydrate turn meta (tool timeline + stats) for assistant rows.
  if (msg.role === "assistant") {
    const meta = getTurnMeta(chatId, msg.id);
    if (meta) {
      // Delivery tools are excluded at record time, but metas
      // persisted by older daemons still carry them — filter on
      // the way out so upgraded installs get clean history too.
      const tools = meta.tools?.filter((t) => !isDeliveryTool(t.name));
      if (tools?.length) msg.tools = tools;
      if (meta.durationMs) msg.durationMs = meta.durationMs;
      if (meta.tokensIn) msg.tokensIn = meta.tokensIn;
      if (meta.tokensOut) msg.tokensOut = meta.tokensOut;
    }
  }
  return msg;
}

/** A page of history: newest window, or the window before `before`. */
export function historyPage(
  runtime: NativeRuntime,
  chatId: string,
  options?: HistoryPageOptions,
): ClientMessage[] {
  // Opening a chat is the one moment we know a client wants its numbers:
  // refresh the context readout on the full path (model fallback and
  // all), which covers every chat the startup warm skipped or couldn't
  // resolve. Fire-and-forget — the figure arrives as a chat_updated.
  const entry = runtime.chats.get(chatId);
  if (entry && options?.before === undefined) {
    void refreshContext(runtime, entry).catch(() => {});
  }
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 500);
  const rows =
    options?.before !== undefined
      ? getHistoryBefore(chatId, options.before, limit)
      : getRecentHistory(chatId, limit);
  return rows
    .map((m) => hydrateHistoryRow(runtime, chatId, m))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/** Full-text search across chats (or one chat when `chatId` is given). */
export function searchHistory(
  runtime: NativeRuntime,
  query: string,
  chatId?: string,
): SearchResult[] {
  const targets = chatId
    ? [runtime.chats.get(chatId)].filter((e): e is ChatEntry => e != null)
    : runtime.chats.list();
  const results: SearchResult[] = [];
  for (const entry of targets) {
    for (const m of searchHistoryMessages(entry.id, query, 10)) {
      results.push({
        chatId: entry.id,
        chatTitle: entry.title,
        message: historyToClientMessage(m, entry.id),
      });
    }
  }
  // Newest hits first, bounded across all chats.
  results.sort((a, b) => b.message.ts - a.message.ts);
  return results.slice(0, 50);
}
