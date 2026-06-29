import { describe, expect, it, vi } from "vitest";
import { Loom, Weaver } from "../core/weaver/index.js";
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
