# Task table

> Status: **implemented** (`src/core/tasks/`). The daemon's registry of agent
> work — the process-table analogue for the agent runtime, with tokens (not
> CPU) as the accounted resource.

## The model

A **task** is one bounded run of agent work. Four kinds exist today, one per
place the runtime actually starts an agent:

| Kind               | Registered by                                          | Killable | Usage captured |
| ------------------ | ------------------------------------------------------ | -------- | -------------- |
| `turn`             | `core/weaver` (every chat turn)                        | yes      | yes            |
| `heartbeat`        | `core/background/heartbeat/agent.ts`                   | yes      | no             |
| `dream`            | `core/background/dream.ts`                             | yes      | no             |
| `cron` / `trigger` | `core/background/job-oneshot.ts` (isolated query jobs) | yes      | no             |

Deliberately **not** tasks: trigger watcher scripts (long-lived OS processes
the trigger store already tracks, pid and all), cron `message` jobs (a single
send, no agent run), and the pulse ticker.

Lifecycle: `queued → running → done | failed | killed`. Chat turns enter as
`queued` while waiting in their chat's FIFO; everything else begins `running`.
Settlement is idempotent — the first terminal state wins.

## Kill semantics

A task is killable when its owner registered an abort hook. `kill` delivers
the abort and returns immediately; the task settles as `killed` when the
owner's failure path lands. A background run that completes despite the
abort settles as `done` — a kill only "takes" when the run actually dies.

Chat turns kill through `ChatBackend.interruptChatTurn` — the same
capability behind the frontend stop affordance, implemented by every
backend (the Claude SDK's native `Query.interrupt()`; the callback
backends via the shared `backend/shared/turn-interrupt.ts` registry, where
a user interrupt is a synthetic turn terminator: the stream closes as a
normal completion carrying the partial text and real usage, never as an
error or a retry). The weaver settles the killed turn's task as `killed`
with that usage while the partial result flows back to the caller. A turn
killed while still queued in its chat's FIFO never reaches the backend —
and never interrupts the same chat's currently running turn.

The table is observational: it never schedules, retries, or times out a run.
Those disciplines stay with the owning module (weaver, heartbeat scheduler,
dream, job-oneshot). It is also in-memory only — a task is a live run, and a
daemon restart ends every run, so there is nothing truthful to persist. The
settled history is a bounded ring (50 entries).

## Token accounting

`turn` tasks record `usage` (input/output/cache tokens) from the turn result.
Isolated one-shots run through `runOneShotAgent`, which reports no usage, so
their tasks settle without it. When the background capability grows usage
reporting, the wiring point is already there (`TaskHandle.succeed(usage)`).

## Surfaces

- **HTTP (gateway, 127.0.0.1)** — `GET /tasks` returns
  `{ ok, tasks: TaskRecord[] }`; `POST /tasks/kill` with `{ id }` returns a
  `KillOutcome` (`ok` / `not-found` / `finished` / `not-killable`).
- **CLI** — `talon ps` renders the table (live tasks first, then history
  newest-first); `talon kill <id>` aborts a killable task.

Labels are content-free by contract (`TaskSpec.label`): the turn source, the
job/trigger name, or the heartbeat run number — never message text, so the
listing can be shown anywhere the daemon's status can.
