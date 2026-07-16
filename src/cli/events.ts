/**
 * `talon events` — tail the daemon's event bus.
 *
 * Renders the gateway's `/events/recent` ring; `--follow` (`-f`) keeps
 * polling with a since-cursor for a live tail. Rendering only — the bus
 * itself lives in core/bus/.
 */

import pc from "picocolors";
import { fetchGateway, requireGatewayPort } from "./daemon-api.js";
import type { PublishedEvent } from "../core/bus/index.js";

const FOLLOW_POLL_MS = 1_000;

function timestamp(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

/** One tail line of type-specific detail, content-free like the events. */
function describe(event: PublishedEvent): string {
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

function render(event: PublishedEvent): void {
  console.log(
    `  ${pc.dim(timestamp(event.at))}  ${pc.cyan(event.type.padEnd(14))}  ${describe(event)}`,
  );
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

export async function showEvents(follow: boolean): Promise<void> {
  console.log();
  const port = await requireGatewayPort();
  if (port === null) return;

  let cursor = 0;
  try {
    const events = await fetchEvents(port, cursor);
    if (events.length === 0 && !follow) {
      console.log(
        `  ${pc.dim("No events yet — the bus ring starts empty on each daemon start.")}\n`,
      );
      return;
    }
    for (const event of events) render(event);
    cursor = events.at(-1)?.id ?? 0;
  } catch (err) {
    console.log(
      `  ${pc.red("✖")} Could not read the event bus: ${err instanceof Error ? err.message : err}\n`,
    );
    return;
  }

  if (!follow) {
    console.log();
    return;
  }
  console.log(`  ${pc.dim("Following — Ctrl+C to stop.")}`);
  for (;;) {
    await sleep(FOLLOW_POLL_MS);
    try {
      const events = await fetchEvents(port, cursor);
      for (const event of events) render(event);
      if (events.length > 0) cursor = events.at(-1)!.id;
    } catch {
      // Transient gateway hiccup (restart mid-follow) — keep polling.
    }
  }
}
