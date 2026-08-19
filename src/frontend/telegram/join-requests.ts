/**
 * Pending chat-join-request tracking.
 *
 * When the bot administers a group whose invite link requires approval,
 * Telegram delivers `chat_join_request` updates. They're stored here (not
 * enqueued as agent turns — a join isn't a conversation) so the agent can
 * review and act when asked: `moderate(op="list_join_requests")`, then
 * approve/decline by user_id.
 *
 * In-memory by design: requests are also visible in Telegram's own UI, so
 * losing the cache on restart costs nothing but a re-request.
 */

export type JoinRequest = {
  userId: number;
  name: string;
  username?: string;
  bio?: string;
  /** Unix ms the request arrived. */
  at: number;
};

const MAX_PER_CHAT = 200;

const pendingByChat = new Map<number, Map<number, JoinRequest>>();

export function recordJoinRequest(chatId: number, req: JoinRequest): void {
  let chat = pendingByChat.get(chatId);
  if (!chat) {
    chat = new Map();
    pendingByChat.set(chatId, chat);
  }
  if (chat.size >= MAX_PER_CHAT && !chat.has(req.userId)) {
    // Drop the oldest (first-inserted) entry to stay bounded.
    const oldest = chat.keys().next();
    if (!oldest.done) chat.delete(oldest.value);
  }
  chat.set(req.userId, req);
}

/** Forget a request once it's been approved/declined (or withdrawn). */
export function clearJoinRequest(chatId: number, userId: number): void {
  pendingByChat.get(chatId)?.delete(userId);
}

export function listJoinRequests(chatId: number): JoinRequest[] {
  return [...(pendingByChat.get(chatId)?.values() ?? [])];
}

/** Test seam. */
export function resetJoinRequests(): void {
  pendingByChat.clear();
}
