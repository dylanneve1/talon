/**
 * Active-turn session registry for Kilo.
 *
 * Tracks the in-flight Kilo session id per chat for the duration of a
 * turn: `message.ts` records the id on entry and clears it in its finally
 * block, and `turn.ts` matches incoming SSE events against it.
 */

export const activeSessions = new Map<string, string>();
