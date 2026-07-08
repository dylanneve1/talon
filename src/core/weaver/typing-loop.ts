/**
 * Typing loop — keeps the frontend's typing indicator alive for the
 * duration of a turn. Sends immediately, then re-sends on an interval;
 * every send is fail-soft (logged, never thrown) because a dropped
 * indicator must not fail the turn.
 */

import { logWarn } from "../../util/log.js";

/** Platforms expire typing indicators after ~5s; refresh under that. */
export const TYPING_REFRESH_MS = 4000;

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
  const send = (label: string) => {
    sendTyping(numericChatId, stringId).catch((err: unknown) => {
      logWarn(
        "dispatcher",
        `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  send("sendTyping");
  const timer = setInterval(() => send("sendTyping interval"), intervalMs);
  return () => clearInterval(timer);
}
