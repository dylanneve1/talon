/**
 * Typing loop — keeps the frontend's typing indicator alive for the
 * duration of a turn. Sends immediately, then re-sends on an interval;
 * every send is fail-soft (logged, never thrown) because a dropped
 * indicator must not fail the turn.
 */

import { logWarn } from "../../util/log.js";

/** Platforms expire typing indicators after ~5s; refresh under that. */
const TYPING_REFRESH_MS = 4000;

/**
 * Consecutive failures after which the loop gives up for the rest of the
 * turn. A chat that has gone away (deleted, kicked, migrated) fails every
 * single refresh, and a long turn then logs one warning every 4 seconds for
 * a cosmetic indicator — 55 of them in 30 seconds on 2026-09-15, all
 * "sendChatAction failed (400: chat not found)". Three strikes is enough to
 * tell a transient blip from a chat that is simply gone.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export type SendTyping = (
  numericChatId: number,
  stringId?: string,
) => Promise<void>;

/** Start the loop. Call the returned function to stop it. */
export function startTypingLoop(
  sendTyping: SendTyping,
  numericChatId: number,
  stringId: string,
  intervalMs = TYPING_REFRESH_MS,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let consecutiveFailures = 0;

  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const send = (label: string) => {
    sendTyping(numericChatId, stringId).then(
      () => {
        consecutiveFailures = 0;
      },
      (err: unknown) => {
        consecutiveFailures++;
        const reason = err instanceof Error ? err.message : String(err);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stop();
          logWarn(
            "dispatcher",
            `${label} failed ${consecutiveFailures}x in a row — no typing indicator for the rest of this turn: ${reason}`,
          );
          return;
        }
        logWarn("dispatcher", `${label} failed: ${reason}`);
      },
    );
  };

  send("sendTyping");
  timer = setInterval(() => send("sendTyping interval"), intervalMs);
  return stop;
}
