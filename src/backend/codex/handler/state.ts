/**
 * Active-turn abort registry for Codex.
 *
 * Tracks the in-flight AbortController per chat so a turn-terminator tool (or
 * an external cancel) can abort the running Codex turn.
 */

/** Tracks the in-flight abort controller per chat so cancellations can land. */
export const activeAborts = new Map<string, AbortController>();

/** Get the in-flight abort controller for a chat, if a turn is running. */
export function getActiveAbort(chatId: string): AbortController | undefined {
  return activeAborts.get(chatId);
}
