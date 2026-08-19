/**
 * Forum-topic (message thread) tracking.
 *
 * In a supergroup with topics enabled, every message lives in a thread, and a
 * bot send without a `message_thread_id` lands in the General topic — so
 * without this the agent answers a question asked in #support over in
 * General. Telegram does route a send that *replies* to a topic message into
 * that topic, but most agent output (reactions aside) is not a reply: draft
 * streaming, scheduled sends, media, and plain `send(type="text")` all go out
 * unanchored.
 *
 * The registry keeps the last inbound thread per chat, updated by the
 * history-capture middleware that already sees every message. Outbound
 * helpers consult it via {@link resolveThreadId}, with an explicit
 * `thread_id` in the action body always winning over the ambient value.
 *
 * Last-write-wins per chat is the right granularity: chats are processed as
 * serial turns, and each turn's replies belong to the topic that woke it.
 */

const lastThreadByChat = new Map<number, number>();

/** Record (or clear) the ambient thread from an inbound message. */
export function noteInboundThread(
  chatId: number,
  msg: { is_topic_message?: boolean; message_thread_id?: number },
): void {
  // `message_thread_id` is also set on plain reply chains in non-forum
  // groups; only `is_topic_message` marks a real forum topic. General-topic
  // messages carry neither, and must clear a stale thread.
  if (msg.is_topic_message && msg.message_thread_id) {
    lastThreadByChat.set(chatId, msg.message_thread_id);
  } else {
    lastThreadByChat.delete(chatId);
  }
}

/** The thread the chat's latest topic message arrived in, if any. */
export function ambientThreadId(chatId: number): number | undefined {
  return lastThreadByChat.get(chatId);
}

/**
 * Thread for an outbound action: an explicit `thread_id` in the body wins,
 * else the chat's ambient thread. `thread_id: 0` (or "general") explicitly
 * targets the General topic, suppressing the ambient value.
 */
export function resolveThreadId(
  body: Record<string, unknown>,
  chatId: number,
): number | undefined {
  const raw = body.thread_id;
  if (raw === 0 || raw === "0" || raw === "general") return undefined;
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (Number.isInteger(n) && n > 0) return n;
  return ambientThreadId(chatId);
}

/** Test seam. */
export function resetThreadRegistry(): void {
  lastThreadByChat.clear();
}
