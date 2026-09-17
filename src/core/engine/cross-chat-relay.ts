/**
 * Cross-chat relay — keeps the session that sent a message somewhere
 * else aware of what came back.
 *
 * `send_via` lets a Telegram session message a WhatsApp number. The
 * reply, though, lands in the WhatsApp chat: a different chat id, a
 * different session, a different history. The session that started the
 * exchange never learns how it went, so the next thing it says about
 * it is a guess — it "sent the message" and then goes blind.
 *
 * So a cross-send subscribes the sending chat to the target chat for a
 * while. Inbound messages on the target are queued for each subscriber
 * and folded into the front of that chat's next turn, the same way a
 * person glancing at their other phone would have seen the reply before
 * answering you.
 *
 * Deliberately passive: the queued reply waits for the origin chat's
 * next turn rather than waking it. The target chat usually has its own
 * live session already handling that message — waking the origin too
 * would mean two sessions independently reacting to one reply, and an
 * unprompted Telegram message every time someone answers on WhatsApp.
 *
 * State is in-memory on purpose. A subscription is a fact about a
 * conversation in flight; after a restart there is no turn waiting for
 * the reply, and a relayed line from before the restart would arrive
 * with no context to attach to.
 */

/** How long a cross-send keeps the sender subscribed to replies. */
export const RELAY_TTL_MS = 6 * 60 * 60 * 1000;

/** Most queued lines held for one chat — a burst can't flood a prompt. */
export const RELAY_MAX_PENDING = 20;

/** Longest single relayed message; the rest is elided. */
export const RELAY_MAX_TEXT = 600;

/** target chat id → origin chat id → time of the last cross-send. */
const subscribers = new Map<string, Map<string, number>>();

/** origin chat id → relayed lines waiting for its next turn. */
const pending = new Map<string, string[]>();

/**
 * Record that `origin` sent into `target`, subscribing it to replies.
 * A repeat send refreshes the window rather than adding a second entry.
 */
export function noteCrossSend(origin: string, target: string): void {
  // Sending into your own chat is not a cross-send; subscribing would
  // relay a chat's own inbound messages back into itself.
  if (!origin || !target || origin === target) return;
  const forTarget = subscribers.get(target) ?? new Map<string, number>();
  forTarget.set(origin, Date.now());
  subscribers.set(target, forTarget);
}

/**
 * An inbound message arrived on `target`. Queue it for every chat still
 * subscribed, and return how many were notified (0 when nobody is
 * listening, which is the overwhelmingly common case).
 */
export function relayInbound(
  target: string,
  senderName: string,
  text: string,
): number {
  const forTarget = subscribers.get(target);
  if (!forTarget?.size) return 0;
  const now = Date.now();
  const body =
    text.length > RELAY_MAX_TEXT
      ? `${text.slice(0, RELAY_MAX_TEXT)}… (truncated)`
      : text;
  let notified = 0;
  for (const [origin, at] of forTarget) {
    // Expiry is evaluated here rather than on a timer: the map is small,
    // and a sweep that never runs can't leak a stale subscription.
    if (now - at > RELAY_TTL_MS) {
      forTarget.delete(origin);
      continue;
    }
    const queue = pending.get(origin) ?? [];
    queue.push(`${senderName} (in ${target}): ${body}`);
    if (queue.length > RELAY_MAX_PENDING) {
      queue.splice(0, queue.length - RELAY_MAX_PENDING);
    }
    pending.set(origin, queue);
    notified++;
  }
  if (!forTarget.size) subscribers.delete(target);
  return notified;
}

/**
 * Drain everything queued for `chatId`. Draining is the point: each
 * relayed line is folded into exactly one turn, so a long conversation
 * doesn't re-read the same reply on every subsequent prompt.
 */
export function takePendingRelay(chatId: string): string[] {
  const queue = pending.get(chatId);
  if (!queue?.length) return [];
  pending.delete(chatId);
  return queue;
}

/**
 * Render drained lines as the block that goes in front of a prompt.
 * Returns "" when there is nothing, so callers can concatenate blindly.
 */
export function formatRelayBlock(lines: readonly string[]): string {
  if (!lines.length) return "";
  return (
    `[Cross-chat: ${lines.length} new message(s) arrived in a chat this ` +
    `session messaged. You have not replied to these — decide whether they ` +
    `need one.]\n` +
    lines.map((l) => `- ${l}`).join("\n") +
    "\n\n"
  );
}

/** Test seam: drop all subscriptions and queued lines. */
export function resetCrossChatRelay(): void {
  subscribers.clear();
  pending.clear();
}
