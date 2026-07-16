/**
 * Task table — public surface.
 *
 * See table.ts for the registry and types.ts for the vocabulary. Wiring
 * points: weaver (turns), heartbeat/agent, dream, background/job-oneshot
 * (isolated cron/trigger jobs); read surfaces: gateway `GET /tasks` +
 * `POST /tasks/kill`, CLI `talon ps` / `talon kill`.
 */

export { TaskTable, taskTable } from "./table.js";
export type {
  KillOutcome,
  TaskBinding,
  TaskHandle,
  TaskKind,
  TaskRecord,
  TaskSpec,
  TaskState,
  TaskUsage,
} from "./types.js";
