/**
 * Task table vocabulary — the daemon's registry of agent work.
 *
 * A task is one bounded run of agent work: a chat turn, a heartbeat pass, a
 * dream consolidation, or an isolated cron/trigger job. The table gives every
 * such run an id, a lifecycle, an owner chat, and — where the run can be
 * aborted — a kill switch. It is the process-table analogue for the agent
 * runtime, with tokens (not CPU) as the accounted resource.
 *
 * Deliberately NOT tasks: trigger watcher scripts (long-lived OS processes
 * owned by the trigger store, which already tracks their pid/status), cron
 * "message" jobs (a single send, no agent run), and the pulse ticker.
 */

/** Which unit of agent work a task represents. */
export type TaskKind = "turn" | "heartbeat" | "dream" | "cron" | "trigger";

/** Task lifecycle. `done`, `failed`, and `killed` are terminal. */
export type TaskState = "queued" | "running" | "done" | "failed" | "killed";

/**
 * Token spend for the run, captured at settlement when the runner reports
 * it. Chat turns report usage today; isolated one-shots run through
 * `runOneShotAgent`, which returns no usage, so their tasks settle without.
 */
export interface TaskUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** What a call site declares when it registers a run with the table. */
export interface TaskSpec {
  readonly kind: TaskKind;
  /**
   * Short human label shown in `talon ps`: the turn source ("message",
   * "trigger", …), the cron job or trigger name, or the heartbeat run
   * number. Never message content — the listing must not leak chat text.
   */
  readonly label: string;
  /** Chat the work belongs to, when it belongs to one. */
  readonly chatId?: string;
  /**
   * Abort the run mid-flight (typically `AbortController.abort`). Present ⇒
   * the task is killable via `TaskTable.kill`. Must not throw; the table
   * swallows a throwing abort so a broken hook cannot break the kill path.
   */
  readonly abort?: () => void;
}

/** The model/backend a task actually resolved to, once known. */
export interface TaskBinding {
  readonly model?: string;
  readonly backendId?: string;
}

/** Immutable snapshot of one task, as returned by `TaskTable.list()`. */
export interface TaskRecord {
  readonly id: number;
  readonly kind: TaskKind;
  readonly label: string;
  readonly chatId?: string;
  readonly state: TaskState;
  readonly killable: boolean;
  /** When the task entered the table (equal to `startedAt` unless queued). */
  readonly queuedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly model?: string;
  readonly backendId?: string;
  /** Failure detail. Also set for killed tasks (the abort's error). */
  readonly error?: string;
  readonly usage?: TaskUsage;
}

/**
 * Mutator handed to the owning call site. Every transition is idempotent:
 * once a task settles, later calls (including a duplicate settle) no-op, so
 * error paths never need to guard against double settlement.
 */
export interface TaskHandle {
  readonly id: number;
  /** Move a queued task to running. No-op unless queued. */
  start(): void;
  /** Record the model/backend the run resolved to. No-op once settled. */
  bind(binding: TaskBinding): void;
  /** Settle as `done`, optionally recording token usage. */
  succeed(usage?: TaskUsage): void;
  /** Settle as `failed` — or `killed` when a kill was requested first. */
  fail(error: unknown): void;
}

/** Result of `TaskTable.kill`. */
export type KillOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "finished" | "not-killable";
    };
