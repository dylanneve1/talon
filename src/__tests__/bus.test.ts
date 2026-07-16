import { describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { TalonBus, type TalonEvent } from "../core/bus/index.js";
import { TaskTable } from "../core/tasks/index.js";
import { logError } from "../util/log.js";

function turnCompleted(chatId: string): TalonEvent {
  return {
    type: "turn.completed",
    chatId,
    source: "message",
    durationMs: 1,
    inputTokens: 0,
    outputTokens: 0,
  };
}

describe("talon bus", () => {
  it("delivers to type subscribers and subscribeAll, in publish order", () => {
    const bus = new TalonBus();
    const seen: string[] = [];
    bus.subscribe("turn.completed", (e) => {
      seen.push(`typed:${e.chatId}`);
    });
    bus.subscribeAll((e) => {
      seen.push(`all:${e.type}`);
    });

    bus.publish(turnCompleted("a"));
    bus.publish({
      type: "turn.started",
      chatId: "b",
      source: "message",
      model: "m",
      backendId: "claude",
    });

    expect(seen).toEqual(["typed:a", "all:turn.completed", "all:turn.started"]);
  });

  it("stamps monotonic ids and publish time", () => {
    const bus = new TalonBus();
    const first = bus.publish(turnCompleted("a"));
    const second = bus.publish(turnCompleted("b"));

    expect(second.id).toBeGreaterThan(first.id);
    expect(first.at).toBeLessThanOrEqual(Date.now());
  });

  it("unsubscribe stops delivery", () => {
    const bus = new TalonBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe("turn.completed", handler);

    bus.publish(turnCompleted("a"));
    unsubscribe();
    bus.publish(turnCompleted("b"));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing subscriber from the publisher and its peers", () => {
    const bus = new TalonBus();
    const after = vi.fn();
    bus.subscribe("turn.completed", () => {
      throw new Error("subscriber bug");
    });
    bus.subscribe("turn.completed", after);

    expect(() => bus.publish(turnCompleted("a"))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      "bus",
      expect.stringContaining("turn.completed"),
      expect.any(Error),
    );
  });

  it("catches a rejecting async subscriber", async () => {
    const bus = new TalonBus();
    bus.subscribe("turn.completed", async () => {
      throw new Error("async subscriber bug");
    });

    bus.publish(turnCompleted("a"));
    await vi.waitFor(() => {
      expect(logError).toHaveBeenCalledWith(
        "bus",
        expect.stringContaining("rejected"),
        expect.any(Error),
      );
    });
  });

  it("keeps a bounded ring and serves a since-cursor", () => {
    const bus = new TalonBus(3);
    for (const chat of ["a", "b", "c", "d", "e"]) {
      bus.publish(turnCompleted(chat));
    }

    const recent = bus.recent();
    expect(recent).toHaveLength(3);
    expect(recent.map((e) => e.id)).toEqual([3, 4, 5]);

    expect(bus.recent(4).map((e) => e.id)).toEqual([5]);
    expect(bus.recent(5)).toEqual([]);
  });
});

describe("task table → bus", () => {
  it("publishes task.started and task.settled snapshots", () => {
    const events: TalonEvent[] = [];
    const table = new TaskTable({ publish: (e) => events.push(e) });

    const task = table.begin({ kind: "heartbeat", label: "#3" });
    task.succeed();

    expect(events.map((e) => e.type)).toEqual(["task.started", "task.settled"]);
    expect(events[0]).toMatchObject({
      task: { kind: "heartbeat", label: "#3", state: "running" },
    });
    expect(events[1]).toMatchObject({ task: { state: "done" } });
  });

  it("queued tasks publish started only once they run, settled on kill", () => {
    const events: TalonEvent[] = [];
    const table = new TaskTable({ publish: (e) => events.push(e) });

    const task = table.enqueue({
      kind: "turn",
      label: "message",
      abort: () => {},
    });
    expect(events).toEqual([]);

    task.start();
    table.kill(task.id);
    task.fail(new Error("aborted"));

    expect(events.map((e) => e.type)).toEqual(["task.started", "task.settled"]);
    expect(events[1]).toMatchObject({ task: { state: "killed" } });
  });
});
