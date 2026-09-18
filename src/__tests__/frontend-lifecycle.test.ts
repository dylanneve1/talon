/**
 * The frontend lifecycle contract: `start()` resolves at STARTED, never
 * at STOPPED.
 *
 * The bug this pins: every network frontend's `start()` used to resolve
 * only when the frontend stopped (grammY's long-poll promise, Teams'
 * `new Promise(() => {})`, WhatsApp's connection loop), so the boot
 * "finished" at shutdown — boot metrics and the resource sampler were
 * armed hours late and the daemon logged `Ready in 17796980ms`.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { runUntilStopped } from "../core/frontend-runtime/run-loop.js";
import { startFrontends } from "../core/frontend-runtime/lifecycle.js";
import type { Frontend } from "../core/frontend-runtime/capabilities.js";

/** Nothing ever settles this — the shape of a real run loop at boot. */
function neverSettles(): Promise<void> {
  return new Promise<void>(() => {});
}

/** Resolves on the next macrotask, so ordering assertions are real. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type FakeFrontend = {
  frontend: Frontend;
  /** Set when start() resolved. */
  started: boolean;
  /** Set when the run loop itself finished unwinding. */
  loopEnded: boolean;
};

/**
 * A frontend shaped like the real ones: a run loop that only ends when
 * `stop()` asks it to, started through `runUntilStopped`.
 */
function fakeFrontend(name: string): FakeFrontend {
  const state: FakeFrontend = {
    started: false,
    loopEnded: false,
    frontend: null as unknown as Frontend,
  };
  let endRun!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    endRun = resolve;
  });
  let stopped: Promise<void> = Promise.resolve();

  state.frontend = {
    name,
    context: {} as Frontend["context"],
    sendTyping: async () => {},
    sendMessage: async () => {},
    getBridgePort: () => 0,
    init: async () => {},
    async start() {
      const handle = runUntilStopped(async (signalReady) => {
        signalReady();
        await stopRequested;
        // The loop takes a moment to unwind after being asked to stop.
        await tick();
        state.loopEnded = true;
      }, vi.fn());
      stopped = handle.stopped;
      await handle.ready;
      state.started = true;
    },
    async stop() {
      endRun();
      await stopped;
    },
  };
  return state;
}

describe("runUntilStopped", () => {
  it("resolves ready while the run loop keeps running", async () => {
    let signal!: () => void;
    const handle = runUntilStopped((signalReady) => {
      signal = signalReady;
      return neverSettles();
    }, vi.fn());

    let stoppedSettled = false;
    void handle.stopped.then(() => {
      stoppedSettled = true;
    });

    signal();
    await expect(handle.ready).resolves.toBeUndefined();
    await tick();
    expect(stoppedSettled).toBe(false);
  });

  it("resolves ready when the loop ends without ever signalling", async () => {
    const handle = runUntilStopped(async () => {}, vi.fn());
    await expect(handle.ready).resolves.toBeUndefined();
    await expect(handle.stopped).resolves.toBeUndefined();
  });

  it("rejects ready when the loop fails before it is listening", async () => {
    const onError = vi.fn();
    const handle = runUntilStopped(async () => {
      throw new Error("no token");
    }, onError);
    await expect(handle.ready).rejects.toThrow("no token");
    // The failure is the caller's — start() rejects with it, so it is
    // not reported a second time.
    await handle.stopped;
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a failure the loop hits after it was listening", async () => {
    const onError = vi.fn();
    const handle = runUntilStopped(async (signalReady) => {
      signalReady();
      await tick();
      throw new Error("socket died");
    }, onError);
    await handle.ready;
    await expect(handle.stopped).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("startFrontends", () => {
  it("resolves once every frontend is listening, run loops still running", async () => {
    const telegram = fakeFrontend("telegram");
    const whatsapp = fakeFrontend("whatsapp");

    await startFrontends([telegram.frontend, whatsapp.frontend]);

    expect(telegram.started).toBe(true);
    expect(whatsapp.started).toBe(true);
    // Nothing stopped: the boot ended at boot, not at shutdown.
    expect(telegram.loopEnded).toBe(false);
    expect(whatsapp.loopEnded).toBe(false);
  });

  it("starts a stdin-sharing frontend alongside the others", async () => {
    // The terminal used to be started only AFTER the boot await
    // resolved, i.e. never, whenever a network frontend was configured.
    const terminal = fakeFrontend("terminal");
    const telegram = fakeFrontend("telegram");

    await startFrontends([terminal.frontend, telegram.frontend]);

    expect(terminal.started).toBe(true);
    expect(telegram.started).toBe(true);
  });

  it("fails the boot when a frontend never comes up", async () => {
    const broken: Frontend = {
      ...fakeFrontend("teams").frontend,
      start: async () => {
        throw new Error("Graph client not initialized");
      },
    };
    await expect(startFrontends([broken])).rejects.toThrow(
      "Graph client not initialized",
    );
  });

  it("stop() still waits for the run loop the boot left running", async () => {
    const whatsapp = fakeFrontend("whatsapp");
    await startFrontends([whatsapp.frontend]);

    const stopping = whatsapp.frontend.stop();
    expect(whatsapp.loopEnded).toBe(false);
    await stopping;
    expect(whatsapp.loopEnded).toBe(true);
  });
});
