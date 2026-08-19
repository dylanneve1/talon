import { describe, expect, it, vi } from "vitest";
import { TaskTable } from "../core/tasks/index.js";

describe("task table", () => {
  it("begin registers a running task; enqueue registers a queued one", () => {
    const table = new TaskTable();

    const running = table.begin({ kind: "heartbeat", label: "#1" });
    const queued = table.enqueue({
      kind: "turn",
      label: "message",
      chatId: "42",
    });

    const records = table.list();
    expect(records).toHaveLength(2);
    const [first, second] = records;
    expect(first).toMatchObject({
      id: running.id,
      kind: "heartbeat",
      state: "running",
      killable: false,
    });
    expect(first!.startedAt).toBeDefined();
    expect(second).toMatchObject({
      id: queued.id,
      kind: "turn",
      state: "queued",
      chatId: "42",
    });
    expect(second!.startedAt).toBeUndefined();
  });

  it("ids are unique and monotonically increasing", () => {
    const table = new TaskTable();
    const ids = [
      table.begin({ kind: "turn", label: "a" }).id,
      table.begin({ kind: "turn", label: "b" }).id,
      table.begin({ kind: "turn", label: "c" }).id,
    ];
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(3);
  });

  it("start moves queued → running exactly once", () => {
    const table = new TaskTable();
    const task = table.enqueue({ kind: "turn", label: "message" });

    task.start();
    const startedAt = table.list()[0]!.startedAt;
    task.start();

    expect(table.list()[0]!.state).toBe("running");
    expect(table.list()[0]!.startedAt).toBe(startedAt);
  });

  it("bind records the resolved model/backend", () => {
    const table = new TaskTable();
    const task = table.begin({ kind: "turn", label: "message" });

    task.bind({ model: "opus-4", backendId: "claude" });

    expect(table.list()[0]).toMatchObject({
      model: "opus-4",
      backendId: "claude",
    });
  });

  it("succeed settles as done and captures usage", () => {
    const table = new TaskTable();
    const task = table.begin({ kind: "turn", label: "message" });

    task.succeed({
      inputTokens: 100,
      outputTokens: 20,
      cacheRead: 5,
      cacheWrite: 1,
    });

    expect(table.list()[0]).toMatchObject({
      state: "done",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheRead: 5,
        cacheWrite: 1,
      },
    });
    expect(table.list()[0]!.endedAt).toBeDefined();
  });

  it("fail settles as failed and records the error message", () => {
    const table = new TaskTable();
    const task = table.begin({ kind: "cron", label: "digest" });

    task.fail(new Error("backend unavailable"));

    expect(table.list()[0]).toMatchObject({
      state: "failed",
      error: "backend unavailable",
    });
  });

  it("fail records usage when the owner reports what the run burned", () => {
    const table = new TaskTable();
    const task = table.begin({ kind: "turn", label: "message" });

    task.fail(new Error("interrupted by kill"), {
      inputTokens: 9,
      outputTokens: 4,
      cacheRead: 2,
      cacheWrite: 1,
    });

    expect(table.list()[0]).toMatchObject({
      state: "failed",
      error: "interrupted by kill",
      usage: { inputTokens: 9, outputTokens: 4, cacheRead: 2, cacheWrite: 1 },
    });
  });

  it("settlement is idempotent — the first terminal state wins", () => {
    const table = new TaskTable();
    const task = table.begin({ kind: "turn", label: "message" });

    task.succeed();
    task.fail(new Error("late"));
    task.succeed({
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });

    const record = table.list()[0]!;
    expect(record.state).toBe("done");
    expect(record.error).toBeUndefined();
    expect(record.usage).toBeUndefined();
  });

  describe("kill", () => {
    it("aborts a live killable task and settles it as killed when it fails", () => {
      const table = new TaskTable();
      const abort = vi.fn();
      const task = table.begin({ kind: "heartbeat", label: "#7", abort });

      const outcome = table.kill(task.id);
      expect(outcome).toEqual({ ok: true });
      expect(abort).toHaveBeenCalledTimes(1);
      expect(table.list()[0]!.state).toBe("running");

      task.fail(new Error("aborted"));
      expect(table.list()[0]).toMatchObject({
        state: "killed",
        error: "aborted",
      });
    });

    it("a run that completes despite the abort settles as done", () => {
      const table = new TaskTable();
      const task = table.begin({
        kind: "dream",
        label: "consolidation",
        abort: vi.fn(),
      });

      table.kill(task.id);
      task.succeed();

      expect(table.list()[0]!.state).toBe("done");
    });

    it("repeat kills report ok without re-firing the abort hook", () => {
      const table = new TaskTable();
      const abort = vi.fn();
      const task = table.begin({ kind: "heartbeat", label: "#7", abort });

      expect(table.kill(task.id)).toEqual({ ok: true });
      expect(table.kill(task.id)).toEqual({ ok: true });
      expect(abort).toHaveBeenCalledTimes(1);
    });

    it("a throwing abort hook does not break the kill path", () => {
      const table = new TaskTable();
      const task = table.begin({
        kind: "heartbeat",
        label: "#7",
        abort: () => {
          throw new Error("contract violation");
        },
      });

      expect(table.kill(task.id)).toEqual({ ok: true });
    });

    it("refuses tasks without an abort hook", () => {
      const table = new TaskTable();
      const task = table.begin({ kind: "turn", label: "message" });

      expect(table.kill(task.id)).toEqual({
        ok: false,
        reason: "not-killable",
      });
    });

    it("distinguishes finished tasks from unknown ids", () => {
      const table = new TaskTable();
      const task = table.begin({ kind: "turn", label: "message" });
      task.succeed();

      expect(table.kill(task.id)).toEqual({ ok: false, reason: "finished" });
      expect(table.kill(9999)).toEqual({ ok: false, reason: "not-found" });
    });

    it("kills only the running turn for a chat, leaving queued work alone", () => {
      const table = new TaskTable();
      const runningAbort = vi.fn();
      const running = table.begin({
        kind: "turn",
        label: "message",
        chatId: "chat-a",
        abort: runningAbort,
      });
      const queued = table.enqueue({
        kind: "turn",
        label: "message",
        chatId: "chat-a",
        abort: vi.fn(),
      });
      table.begin({
        kind: "turn",
        label: "message",
        chatId: "chat-b",
        abort: vi.fn(),
      });

      expect(table.killRunningTurn("chat-a")).toEqual({ ok: true });
      expect(runningAbort).toHaveBeenCalledTimes(1);
      expect(table.list().find((task) => task.id === running.id)!.state).toBe(
        "running",
      );
      expect(table.list().find((task) => task.id === queued.id)!.state).toBe(
        "queued",
      );
      expect(table.killRunningTurn("chat-missing")).toEqual({
        ok: false,
        reason: "not-found",
      });
    });
  });

  it("keeps settled history bounded while live tasks are never evicted", () => {
    const table = new TaskTable({ historyLimit: 3 });

    const live = table.begin({ kind: "turn", label: "live" });
    for (let i = 0; i < 5; i++) {
      table.begin({ kind: "turn", label: `settled-${i}` }).succeed();
    }

    const records = table.list();
    // 3 retained settled tasks + the live one.
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.label)).toEqual([
      "live",
      "settled-2",
      "settled-3",
      "settled-4",
    ]);
    expect(records.find((r) => r.id === live.id)!.state).toBe("running");
  });

  it("list returns id-ascending snapshots that do not mutate the table", () => {
    const table = new TaskTable();
    table.begin({ kind: "turn", label: "a" });
    const task = table.begin({ kind: "cron", label: "b" });
    task.succeed();

    const records = table.list();
    expect(records.map((r) => r.id)).toEqual(
      records.map((r) => r.id).sort((a, b) => a - b),
    );

    (records[0] as { label: string }).label = "tampered";
    (records[1] as { label: string }).label = "tampered";
    expect(table.list().map((r) => r.label)).toEqual(["a", "b"]);
  });
});
