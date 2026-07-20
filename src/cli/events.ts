/**
 * `talon events` — tail the daemon's event bus.
 *
 * Renders the gateway's `/events/recent` ring; `--follow` (`-f`) keeps
 * polling with a since-cursor for a live tail; `--history [N]` reads the
 * durable journal in talon.db instead (works across restarts, daemon up
 * or down). Rendering only — the bus lives in core/bus/, the journal in
 * storage/journal.ts.
 */

import pc from "picocolors";
import { fetchGateway, requireGatewayPort } from "./daemon-api.js";
import type { PublishedEvent, TalonEvent } from "../core/bus/index.js";

const FOLLOW_POLL_MS = 1_000;

function timestamp(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

/** One tail line of type-specific detail, content-free like the events. */
function describe(event: TalonEvent): string {
  switch (event.type) {
    case "task.started":
      return (
        `#${event.task.id} ${event.task.kind} "${event.task.label}"` +
        (event.task.chatId ? ` chat=${event.task.chatId}` : "")
      );
    case "task.settled":
      return (
        `#${event.task.id} ${event.task.kind} "${event.task.label}" → ${event.task.state}` +
        (event.task.error ? ` (${event.task.error})` : "")
      );
    case "turn.started":
      return `chat=${event.chatId} ${event.backendId}/${event.model} (${event.source})`;
    case "turn.completed":
      return `chat=${event.chatId} ${event.durationMs}ms in=${event.inputTokens} out=${event.outputTokens}`;
  }
}

function render(event: TalonEvent, at: number): void {
  console.log(
    `  ${pc.dim(timestamp(at))}  ${pc.cyan(event.type.padEnd(14))}  ${describe(event)}`,
  );
}

/**
 * The journal path: read the durable tail from talon.db directly — no
 * daemon required, and it answers across restarts (unlike the ring).
 */
async function showHistory(limit: number): Promise<void> {
  const { readJournal } = await import("../storage/journal.js");
  let entries;
  try {
    entries = readJournal<TalonEvent & { at: number }>({ limit });
  } catch (err) {
    console.log(
      `  ${pc.red("✖")} Could not read the journal: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (entries.length === 0) {
    console.log(`  ${pc.dim("Journal is empty — no events recorded yet.")}\n`);
    return;
  }
  // readJournal returns newest-first; a tail reads oldest-to-newest.
  for (const entry of entries.reverse()) render(entry.event, entry.at);
  console.log();
}

async function fetchEvents(
  port: number,
  sinceId: number,
): Promise<PublishedEvent[]> {
  const body = (await fetchGateway(
    port,
    `/events/recent?since=${sinceId}`,
  )) as { events?: PublishedEvent[] };
  return body.events ?? [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function showEvents(options: {
  follow: boolean;
  history?: number;
}): Promise<void> {
  console.log();
  if (options.history !== undefined) {
    await showHistory(options.history);
    return;
  }

  const port = await requireGatewayPort();
  if (port === null) return;

  let cursor = 0;
  try {
    const events = await fetchEvents(port, cursor);
    if (events.length === 0 && !options.follow) {
      console.log(
        `  ${pc.dim("No events yet — the ring starts empty on each daemon start. Older events: talon events --history")}\n`,
      );
      return;
    }
    for (const event of events) render(event, event.at);
    cursor = events.at(-1)?.id ?? 0;
  } catch (err) {
    console.log(
      `  ${pc.red("✖")} Could not read the event bus: ${err instanceof Error ? err.message : err}\n`,
    );
    return;
  }

  if (!options.follow) {
    console.log();
    return;
  }
  console.log(`  ${pc.dim("Following — Ctrl+C to stop.")}`);
  for (;;) {
    await sleep(FOLLOW_POLL_MS);
    try {
      const events = await fetchEvents(port, cursor);
      for (const event of events) render(event, event.at);
      if (events.length > 0) cursor = events.at(-1)!.id;
    } catch {
      // Transient gateway hiccup (restart mid-follow) — keep polling.
    }
  }
}
