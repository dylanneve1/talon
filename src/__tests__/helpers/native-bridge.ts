/**
 * Test helper — a native-bridge runtime with a recording broadcast sink.
 *
 * The bridge modules (turn, chat-lifecycle, reset, models, handlers, …) all
 * take a `NativeRuntime` as their first parameter and report what they did
 * by broadcasting. Tests therefore need the same two things every time: a
 * real runtime over the per-worker SQLite store, and the list of events it
 * fanned out. `makeNativeHarness` builds both; `settle` waits for the
 * fire-and-forget tails (`void promise.catch()`, `setImmediate`) the turn
 * loop uses.
 *
 * Production code never uses this — `createNativeFrontend` constructs the
 * runtime there, with `server.broadcast` as the sink.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { Gateway } from "../../core/engine/gateway.js";
import type { BridgeEvent } from "../../frontend/native/protocol.js";
import {
  createNativeRuntime,
  type NativeRuntime,
} from "../../frontend/native/runtime.js";

export type NativeHarness = {
  runtime: NativeRuntime;
  /** Every event the runtime broadcast, in order. */
  events: BridgeEvent[];
  /** Just the broadcast events of one kind, in order. */
  eventsOf<K extends BridgeEvent["kind"]>(
    kind: K,
  ): Extract<BridgeEvent, { kind: K }>[];
};

export function makeNativeHarness(
  config: Partial<TalonConfig> = {},
): NativeHarness {
  const events: BridgeEvent[] = [];
  const runtime = createNativeRuntime(
    {
      botDisplayName: "Talon",
      backend: "claude",
      model: "test-model",
      ...config,
    } as TalonConfig,
    {} as Gateway,
    (event) => events.push(event),
  );
  return {
    runtime,
    events,
    eventsOf: (kind) =>
      events.filter((e) => e.kind === kind) as Extract<
        BridgeEvent,
        { kind: typeof kind }
      >[],
  };
}

/** Drain queued microtasks and `setImmediate` callbacks, `turns` times. */
export async function settle(turns = 2): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
