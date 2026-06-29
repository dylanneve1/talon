/**
 * ThreadSession — a Thread's handle to its persisted session.
 *
 * Per-chat session state (backend resume id, turn count, cumulative usage)
 * lives in `storage/sessions.ts`, keyed by chat id, and remains the source of
 * truth: backends resume from it and commit usage to it. This handle gives the
 * Thread first-class, chat-scoped *read* access to that state, so the Weaver,
 * snapshots, and remote frontends reach a chat's session *through its Thread*
 * instead of passing the chat id around. It is a thin proxy — no caching, no
 * second source of truth. (Write paths still run through the store directly;
 * they migrate onto this handle as callsites move under the Weaver.)
 */

import { getSessionInfo, type SessionInfo } from "../../storage/sessions.js";

/** Compact session summary for `weaver.snapshot()`. */
export type SessionSummary = {
  /** Backend resume id, once a session has been established. */
  sessionId?: string;
  /** Completed turns in this session. */
  turns: number;
  /** Model the last recorded turn ran on. */
  lastModel?: string;
  /** True while a turn is streaming and usage includes its live so-far counts. */
  turnInProgress: boolean;
};

export class ThreadSession {
  constructor(private readonly chatId: string) {}

  /** Non-creating read of the session's current state + live-turn overlay. */
  info(): SessionInfo {
    return getSessionInfo(this.chatId);
  }

  /** The backend resume id, if a session has been established. */
  get id(): string | undefined {
    return getSessionInfo(this.chatId).sessionId;
  }

  /** Compact summary for snapshots and remote status surfaces. */
  summary(): SessionSummary {
    const info = getSessionInfo(this.chatId);
    return {
      sessionId: info.sessionId,
      turns: info.turns,
      lastModel: info.lastModel,
      turnInProgress: info.turnInProgress ?? false,
    };
  }
}
