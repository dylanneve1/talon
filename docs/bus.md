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

The bus keeps a bounded ring (200) of recent events with monotonic ids.
In-memory only — events describe moments in a live process, so nothing is
persisted.

- **HTTP (gateway, 127.0.0.1)** — `GET /events/recent?since=<id>` returns
  `{ ok, events }`, id-ascending; `since` is the follow cursor.
- **CLI** — `talon events` prints the ring; `talon events -f` follows.

Event payloads are content-free (ids, kinds, labels, counts — never message
text), same contract as the task table.
