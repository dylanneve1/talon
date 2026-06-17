/**
 * Active-turn abort registry for the OpenAI Agents backend.
 *
 * Tracks the in-flight abort controller per chat so gateway actions (e.g.
 * user-driven cancel) and turn-terminator tools can stop a running turn.
 */

export const activeAborts = new Map<string, AbortController>();

/** Get the in-flight abort controller for a chat, if a turn is running. */
export function getActiveAbort(chatId: string): AbortController | undefined {
  return activeAborts.get(chatId);
}
