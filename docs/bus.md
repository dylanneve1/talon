# Event bus

> Status: **implemented** (`src/core/bus/`). The daemon's internal event
> spine — subsystems react to each other by subscribing, not by importing
> each other.

## The model

One `TalonBus` instance serves the process. Producers publish typed events
(a closed union in `events.ts`); consumers subscribe by type and get
synchronous, publish-ordered, fire-and-forget delivery — a subscriber that
throws (or rejects) is logged and never affects the publisher or its peers.
Subscribers must not block.

The vocabulary is deliberately honest: an event type exists only when
something in the runtime actually publishes it, and each addition should
land together with its publisher and first subscriber.

| Event            | Published by              | Meaning                                                                             |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `task.started`   | task table (`core/tasks`) | any unit of agent work left the queue and began running                             |
| `task.settled`   | task table                | a task reached `done` / `failed` / `killed`                                         |
| `turn.started`   | Weaver                    | a chat turn bound its warp and is about to run (never fires for a no-model refusal) |
| `turn.completed` | Weaver                    | a chat turn finished successfully (failures throw past it)                          |

## Absorbed seams

The bus replaced two callbacks that used to thread through `WeaverDeps`:

- `onTurnStart` → bootstrap subscribes `maybeStartDream` to `turn.started`;
- `onActivity` → bootstrap subscribes `resetPulseTimer` to `turn.completed`.

Same moments, same semantics, one less dependency thread each — the Weaver
publishes facts and stays ignorant of dream and pulse. This is the pattern
for future work: triggers as subscribers instead of pollers, companion task
feeds, mesh presence transitions.

## Tail

The bus keeps a bounded ring (200) of recent events with monotonic ids —
the live-tail surface. Live state stays in-memory; history is the
journal's job (below).

- **HTTP (gateway, 127.0.0.1)** — `GET /events/recent?since=<id>` returns
  `{ ok, events }`, id-ascending; `since` is the follow cursor.
- **CLI** — `talon events` prints the ring; `talon events -f` follows.

Event payloads are content-free (ids, kinds, labels, counts — never message
text), same contract as the task table.

## Journal — the durable tail

> Status: **implemented** (`src/storage/journal.ts`). The bus's syslog.

A bootstrap subscriber (`bus.subscribeAll`) appends every published event
to the `journal` table in talon.db — one JSON document per row, type and
timestamp lifted into columns, `seq` as the durable cursor (per-process
bus ids restart with the daemon). Retention is bounded (20k rows, pruned
opportunistically); appends never throw — a full disk must not break the
bus or the publisher behind it.

This is what makes history answerable across restarts, with or without a
daemon:

- `talon events --history [N]` — the last N journal entries, read
  straight from talon.db.
- `talon ps --all` — the live task table plus settled runs reconstructed
  from `task.settled` events (deduped by `(id, queuedAt)`, since
  per-process task ids repeat between daemon runs).

The division of truth is deliberate: the task table and ring describe a
live process and stay in-memory; the journal records what *happened* —
and everything that happens already crosses the bus as a typed,
content-free event, so one subscriber journals the entire runtime.
