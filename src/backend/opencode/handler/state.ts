/**
 * Active-turn session registry for OpenCode.
 *
 * Tracks the in-flight OpenCode session id per chat so gateway actions (e.g.
 * abort on user `/cancel`, refresh MCP on plugin reload) can reach into a
 * running turn without going through chat state.
 */

export const activeSessions = new Map<string, string>();

/** Get the in-flight OpenCode session id for a chat, if a turn is running. */
export function getActiveSession(chatId: string): string | undefined {
  return activeSessions.get(chatId);
}
