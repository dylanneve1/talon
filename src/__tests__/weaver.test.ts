import { describe, expect, it, vi } from "vitest";
import { Loom, Thread, Weaver } from "../core/weaver/index.js";
import type { ExecuteParams } from "../core/types.js";
import { stubBackend, stubResolveActiveModel } from "./helpers/stub-backend.js";

function params(input: Partial<ExecuteParams> = {}): ExecuteParams {
  return {
    chatId: input.chatId ?? "chat",
    numericChatId: input.numericChatId ?? 1,
    prompt: input.prompt ?? "hello",
    senderName: input.senderName ?? "User",
    isGroup: input.isGroup ?? false,
    source: input.source ?? "message",
    onEvent: input.onEvent,
    modelOverride: input.modelOverride,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("weaver", () => {
  it("lazily creates one Thread per chat", () => {
    const loom = new Loom();

    const first = loom.thread("a");
    const second = loom.thread("a");
    const other = loom.thread("b");

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(loom.size()).toBe(2);
    expect(loom.chatIds()).toEqual(["a", "b"]);
  });

  it("evicts idle Threads and skips busy Threads", async () => {
    const loom = new Loom();
    const gate = deferred();
    const thread = loom.thread("busy");

    const run = thread.enqueue(async () => {
      await gate.promise;
      return "done";
    });

    await Promise.resolve();
    expect(loom.evict("busy")).toBe(false);

    gate.resolve();
    await run;
    await Promise.resolve();

    expect(loom.evict("busy")).toBe(true);
    expect(loom.get("busy")).toBeUndefined();
  });

  it("serializes same-chat turns FIFO through runTurn", async () => {
    const first = deferred();
    const second = deferred();
    const order: string[] = [];

    const backend = stubBackend({
      query: vi.fn(async (queryParams) => {
        order.push(`start:${queryParams.text}`);
        await (queryParams.text === "first" ? first.promise : second.promise);
        order.push(`end:${queryParams.text}`);
        return {
          text: queryParams.text,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }),
    });

    const weaver = new Weaver({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
      onActivity: vi.fn(),
    });

    const p1 = weaver.runTurn(params({ chatId: "same", prompt: "first" }));
    const p2 = weaver.runTurn(params({ chatId: "same", prompt: "second" }));

    await vi.waitFor(() => {
      expect(order).toEqual(["start:first"]);
    });

    first.resolve();
    await p1;
    await vi.waitFor(() => {
      expect(order).toEqual(["start:first", "end:first", "start:second"]);
    });

    second.resolve();
    await p2;
    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
  });

  it("runs different-chat turns in parallel through runTurn", async () => {
    const a = deferred();
    const b = deferred();
    const order: string[] = [];

    const backend = stubBackend({
      query: vi.fn(async (queryParams) => {
        order.push(`start:${queryParams.chatId}`);
        await (queryParams.chatId === "a" ? a.promise : b.promise);
        order.push(`end:${queryParams.chatId}`);
        return {
          text: queryParams.text,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }),
    });

    const weaver = new Weaver({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
      onActivity: vi.fn(),
    });

    const p1 = weaver.runTurn(params({ chatId: "a", prompt: "first" }));
    const p2 = weaver.runTurn(params({ chatId: "b", prompt: "second" }));

    await vi.waitFor(() => {
      expect(order).toEqual(["start:a", "start:b"]);
    });

    a.resolve();
    b.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start:a", "start:b", "end:a", "end:b"]);
  });
});

describe("thread execution context", () => {
  it("brackets a turn: acquire resets the per-turn counter, release clears", () => {
    const thread = new Thread("c");
    expect(thread.contextActive).toBe(false);
    expect(thread.busy).toBe(false);

    thread.acquireContext(42);
    expect(thread.contextActive).toBe(true);
    expect(thread.busy).toBe(true);
    expect(thread.numericChatId).toBe(42);
    expect(thread.messageCount).toBe(0);

    thread.noteMessageSent();
    thread.noteMessageSent();
    expect(thread.messageCount).toBe(2);

    thread.releaseContext();
    expect(thread.contextActive).toBe(false);

    // The next turn's first acquire starts a fresh per-turn counter.
    thread.acquireContext(42);
    expect(thread.messageCount).toBe(0);
  });

  it("ref-counts re-entrant context holds", () => {
    const thread = new Thread("c");
    thread.acquireContext(1);
    thread.acquireContext(1);
    thread.releaseContext();
    expect(thread.contextActive).toBe(true);
    thread.releaseContext();
    expect(thread.contextActive).toBe(false);
  });
});

describe("loom context registry", () => {
  it("keys context on stringId, falling back to String(numeric)", () => {
    const loom = new Loom();

    // Telegram-style: no stringId — the numeric id IS the chat id.
    loom.acquireContext(123);
    expect(loom.get("123")).toBeDefined();
    expect(loom.hasActiveContext(123)).toBe(true);
    expect(loom.numericForStringId("123")).toBe(123);

    // Teams/Discord-style: an explicit non-numeric string id.
    loom.acquireContext(456, "chat:abc");
    expect(loom.get("chat:abc")?.numericChatId).toBe(456);
    expect(loom.numericForStringId("chat:abc")).toBe(456);
    expect(loom.activeContextCount()).toBe(2);
  });

  it("resolves to the same Thread the Weaver serializes the turn on", () => {
    const loom = new Loom();
    const serial = loom.thread("chat:abc"); // runTurn keys here (params.chatId)
    const ctx = loom.acquireContext(456, "chat:abc"); // context keys here
    expect(ctx).toBe(serial);
  });

  it("tracks message count against the active context and resets on re-acquire", () => {
    const loom = new Loom();
    loom.acquireContext(7);
    loom.noteMessageSent(7);
    expect(loom.messageCount(7)).toBe(1);

    loom.releaseContext(7);
    expect(loom.messageCount(7)).toBe(0); // numeric index cleared
    expect(loom.hasActiveContext(7)).toBe(false);

    loom.acquireContext(7);
    expect(loom.messageCount(7)).toBe(0); // fresh per turn
  });

  it("releases context by a Teams-style non-numeric string id", () => {
    const loom = new Loom();
    loom.acquireContext(99, "19:abc");
    expect(loom.hasActiveContext(99)).toBe(true);
    loom.releaseContext("19:abc");
    expect(loom.hasActiveContext(99)).toBe(false);
  });

  it("keeps the numeric id as the refcount identity across calls", () => {
    const loom = new Loom();
    // A re-entrant acquire for a numeric that already holds a context refs the
    // same Thread even if the second call omits the string id.
    const first = loom.acquireContext(7003, "teams-thread-xyz");
    const second = loom.acquireContext(7003);
    expect(second).toBe(first);

    loom.releaseContext("teams-thread-xyz");
    expect(loom.hasActiveContext(7003)).toBe(true); // refCount 1
    loom.releaseContext(7003);
    expect(loom.hasActiveContext(7003)).toBe(false); // refCount 0
  });
});

describe("warp + snapshot", () => {
  it("bindWarp reports drift only when the model or backend changes", () => {
    const thread = new Thread("c");
    expect(
      thread.bindWarp({
        model: "m1",
        backendId: "claude",
        overridden: false,
        boundAt: 1,
      }).drifted,
    ).toBe(false);
    expect(
      thread.bindWarp({
        model: "m1",
        backendId: "claude",
        overridden: false,
        boundAt: 2,
      }).drifted,
    ).toBe(false);
    const result = thread.bindWarp({
      model: "m2",
      backendId: "claude",
      overridden: false,
      boundAt: 3,
    });
    expect(result.drifted).toBe(true);
    expect(result.previous?.model).toBe("m1");
  });

  it("reports the resolved warp + session per live Thread after a turn", async () => {
    const backend = stubBackend();
    const weaver = new Weaver({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel("claude", "stub-model"),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
      onActivity: vi.fn(),
    });

    await weaver.runTurn(params({ chatId: "snap", numericChatId: 5 }));

    const entry = weaver.snapshot().find((s) => s.chatId === "snap");
    expect(entry).toBeDefined();
    expect(entry?.warp?.model).toBe("stub-model");
    expect(entry?.warp?.backendId).toBe("claude");
    expect(entry?.warp?.overridden).toBe(false);
    expect(entry?.session.turns).toBe(0);
  });
});
