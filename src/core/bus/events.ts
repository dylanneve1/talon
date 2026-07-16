/**
 * Event vocabulary — every event the Talon bus carries.
 *
 * The union is deliberately small and honest: a type exists here only when
 * something in the runtime actually publishes it. Growing the vocabulary is
 * a one-line union change; each addition should land together with its
 * publisher (and ideally its first subscriber).
 *
 * Two families exist today:
 *
 *   - `task.*` — lifecycle of agent work, published by the task table
 *     (core/tasks). Uniform across kinds: a heartbeat pass, a dream run, an
 *     isolated cron/trigger job, and a chat turn all surface here.
 *   - `turn.*` — the chat-domain moments inside a turn that other
 *     subsystems key off: `turn.started` fires once the warp is bound and
 *     the backend is about to run (never for a no-model refusal);
 *     `turn.completed` fires only for a successfully finished turn.
 */

import type { TaskRecord } from "../tasks/types.js";

/** A task left the queue and began running. */
export interface TaskStartedEvent {
  readonly type: "task.started";
  readonly task: TaskRecord;
}

/** A task reached a terminal state (done / failed / killed). */
export interface TaskSettledEvent {
  readonly type: "task.settled";
  readonly task: TaskRecord;
}

/** A chat turn bound its warp and is about to run on the backend. */
export interface TurnStartedEvent {
  readonly type: "turn.started";
  readonly chatId: string;
  readonly source: string;
  readonly model: string;
  readonly backendId: string;
}

/** A chat turn finished successfully (refusals and failures never emit this). */
export interface TurnCompletedEvent {
  readonly type: "turn.completed";
  readonly chatId: string;
  readonly source: string;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type TalonEvent =
  TaskStartedEvent | TaskSettledEvent | TurnStartedEvent | TurnCompletedEvent;

export type TalonEventType = TalonEvent["type"];

/** What subscribers receive: the event plus its bus stamp. */
export type PublishedEvent = TalonEvent & {
  /** Monotonic per-process sequence number — the tail cursor. */
  readonly id: number;
  /** Publish time, epoch ms. */
  readonly at: number;
};
