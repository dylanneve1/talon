/**
 * Event vocabulary — every event the Talon bus carries.
 *
 * The union is deliberately small and honest: a type exists here only when
 * something in the runtime actually publishes it. Growing the vocabulary is
 * a one-line union change; each addition should land together with its
 * publisher (and ideally its first subscriber).
 *
 * Three families exist today:
 *
 *   - `task.*` — lifecycle of agent work, published by the task table
 *     (core/tasks). Uniform across kinds: a heartbeat pass, a dream run, an
 *     isolated cron/trigger job, and a chat turn all surface here.
 *   - `agent.*` — the sub-agent lifecycle, published by `core/agents`:
 *     `agent.spawned` when an isolated sub-agent run starts, `agent.settled`
 *     when it reaches a terminal state, `agent.message` when a note or a
 *     report crosses between an agent and its parent.
 *   - `backup.*` — the snapshot lifecycle, published by `core/backup`:
 *     `backup.started` / `backup.completed` / `backup.failed` per run, and
 *     `backup.uploaded` once per target a snapshot reaches.
 *   - `turn.*` — the chat-domain moments inside a turn that other
 *     subsystems key off: `turn.started` fires once the warp is bound and
 *     the backend is about to run (never for a no-model refusal);
 *     `turn.completed` fires only for a successfully finished turn.
 */

import type { TaskRecord } from "../tasks/types.js";
import type { AgentState } from "../agents/types.js";

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
interface TurnStartedEvent {
  readonly type: "turn.started";
  readonly chatId: string;
  readonly source: string;
  readonly model: string;
  readonly backendId: string;
}

/** A chat turn finished successfully (refusals and failures never emit this). */
interface TurnCompletedEvent {
  readonly type: "turn.completed";
  readonly chatId: string;
  readonly source: string;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A sub-agent was registered and its isolated run began. */
export interface AgentSpawnedEvent {
  readonly type: "agent.spawned";
  readonly agentId: string;
  readonly label: string;
  readonly parentKind: "chat" | "agent";
  /** Chat key or parent agent id — an identifier, never content. */
  readonly parent: string;
  readonly backendId: string;
  readonly model: string;
  readonly depth: number;
}

/** A sub-agent reached a terminal state. */
export interface AgentSettledEvent {
  readonly type: "agent.settled";
  readonly agentId: string;
  readonly label: string;
  readonly state: AgentState;
  readonly durationMs: number;
}

/**
 * A message crossed between a sub-agent and its parent: an explicit note
 * (`message`), or the settlement report (`result`). Ids only — the text
 * itself never rides the bus.
 */
interface AgentMessageEvent {
  readonly type: "agent.message";
  /** Chat key or agent id. */
  readonly from: string;
  /** Chat key or agent id. */
  readonly to: string;
  readonly kind: "message" | "result";
}

/** A snapshot run began. `trigger` is what asked for it, never content. */
interface BackupStartedEvent {
  readonly type: "backup.started";
  readonly kind: "backup" | "checkpoint";
  /** "schedule", "manual", "pre-update", "pre-restore", … */
  readonly trigger: string;
}

/** A snapshot was written and indexed. */
interface BackupCompletedEvent {
  readonly type: "backup.completed";
  /** Not `id`: the bus stamps every published event with its own numeric id. */
  readonly snapshotId: string;
  readonly kind: "backup" | "checkpoint";
  readonly sizeBytes: number;
  readonly parts: number;
  readonly durationMs: number;
}

/** A snapshot run failed. `error` is the reason, never a path's contents. */
interface BackupFailedEvent {
  readonly type: "backup.failed";
  readonly trigger: string;
  readonly error: string;
  readonly consecutiveFailures: number;
}

/** One snapshot reached one remote target. */
interface BackupUploadedEvent {
  readonly type: "backup.uploaded";
  readonly snapshotId: string;
  readonly targetId: string;
  readonly bytes: number;
  /** True when the target already held every part (content-addressed reuse). */
  readonly deduplicated: boolean;
}

export type TalonEvent =
  | TaskStartedEvent
  | TaskSettledEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | AgentSpawnedEvent
  | AgentSettledEvent
  | AgentMessageEvent
  | BackupStartedEvent
  | BackupCompletedEvent
  | BackupFailedEvent
  | BackupUploadedEvent;

export type TalonEventType = TalonEvent["type"];

/** What subscribers receive: the event plus its bus stamp. */
export type PublishedEvent = TalonEvent & {
  /** Monotonic per-process sequence number — the tail cursor. */
  readonly id: number;
  /** Publish time, epoch ms. */
  readonly at: number;
};
