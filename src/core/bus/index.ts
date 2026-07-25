/**
 * Event bus — public surface.
 *
 * See bus.ts for the spine and events.ts for the vocabulary. Publishers
 * today: the task table (task.*) and the Weaver (turn.*). Subscribers are
 * wired at the composition root (bootstrap: dream on turn.started, pulse on
 * turn.completed); read surfaces: gateway `GET /events/recent`, CLI
 * `talon events`.
 */

export { TalonBus, bus } from "./bus.js";
export type { PublishedEvent, TalonEvent } from "./events.js";
