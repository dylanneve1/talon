import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDispatcher, execute, getActiveCount } from "../core/dispatcher.js";
import type { QueryBackend, ContextManager } from "../core/types.js";

function createMockDeps() {
  const acquired: number[] = [];
  const released: number[] = [];

  const backend: QueryBackend = {
    query: vi.fn(async () => ({
      text: "response",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 5,
      cacheWrite: 3,
    })),
  };

  const context: ContextManager = {
    acquire: vi.fn((chatId: number) => { acquired.push(chatId); }),
    release: vi.fn((chatId: number) => { released.push(chatId); }),
    getMessageCount: vi.fn(() => 0),
  };

  const sendTyping = vi.fn(async () => {});
  const onActivity = vi.fn();

  return { backend, context, sendTyping, onActivity, acquired, released };
}

describe("dispatcher", () => {
  beforeEach(() => {
    const deps = createMockDeps();
    initDispatcher(deps);
  });

  it("executes a query and returns result", async () => {
    const result = await execute({
      chatId: "123",
      numericChatId: 123,
      prompt: "hello",
      senderName: "User",
      isGroup: false,
      source: "message",
    });
    expect(result.text).toBe("response");
    expect(result.durationMs).toBe(100);
    expect(result.bridgeMessageCount).toBe(0);
  });

  it("acquires and releases context", async () => {
    const deps = createMockDeps();
    initDispatcher(deps);

    await execute({
      chatId: "456",
      numericChatId: 456,
      prompt: "test",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(deps.context.acquire).toHaveBeenCalledWith(456, "456");
    expect(deps.context.release).toHaveBeenCalledWith(456);
  });

  it("releases context even on error", async () => {
    const deps = createMockDeps();
    (deps.backend.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("boom"),
    );
    initDispatcher(deps);

    await expect(
      execute({
        chatId: "789",
        numericChatId: 789,
        prompt: "fail",
        senderName: "User",
        isGroup: false,
        source: "message",
      }),
    ).rejects.toThrow("boom");

    expect(deps.context.release).toHaveBeenCalledWith(789);
  });

  it("sends typing on execution", async () => {
    const deps = createMockDeps();
    initDispatcher(deps);

    await execute({
      chatId: "111",
      numericChatId: 111,
      prompt: "hi",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(deps.sendTyping).toHaveBeenCalledWith(111);
  });

  it("calls onActivity after successful query", async () => {
    const deps = createMockDeps();
    initDispatcher(deps);

    await execute({
      chatId: "222",
      numericChatId: 222,
      prompt: "hi",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(deps.onActivity).toHaveBeenCalled();
  });

  it("does not call onActivity on error", async () => {
    const deps = createMockDeps();
    (deps.backend.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("fail"),
    );
    initDispatcher(deps);

    await expect(
      execute({
        chatId: "333",
        numericChatId: 333,
        prompt: "fail",
        senderName: "User",
        isGroup: false,
        source: "message",
      }),
    ).rejects.toThrow();

    expect(deps.onActivity).not.toHaveBeenCalled();
  });

  it("passes stream callbacks to backend", async () => {
    const deps = createMockDeps();
    initDispatcher(deps);
    const onStreamDelta = vi.fn();
    const onTextBlock = vi.fn();

    await execute({
      chatId: "444",
      numericChatId: 444,
      prompt: "stream",
      senderName: "User",
      isGroup: false,
      source: "message",
      onStreamDelta,
      onTextBlock,
    });

    expect(deps.backend.query).toHaveBeenCalledWith(
      expect.objectContaining({ onStreamDelta, onTextBlock }),
    );
  });

  it("tracks active count", async () => {
    expect(getActiveCount()).toBe(0);

    const deps = createMockDeps();
    let resolveQuery!: () => void;
    (deps.backend.query as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<{ text: string; durationMs: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }>((r) => {
        resolveQuery = () => r({ text: "", durationMs: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });
      }),
    );
    initDispatcher(deps);

    const p = execute({ chatId: "555", numericChatId: 555, prompt: "hi", senderName: "U", isGroup: false, source: "message" });
    // Give it a tick to start
    await new Promise((r) => setTimeout(r, 10));
    expect(getActiveCount()).toBe(1);

    resolveQuery();
    await p;
    expect(getActiveCount()).toBe(0);
  });

  it("runs different-chat queries in true parallel", async () => {
    const order: string[] = [];
    const backend: QueryBackend = {
      query: vi.fn(async (params) => {
        order.push(`start:${params.chatId}`);
        await new Promise((r) => setTimeout(r, 50));
        order.push(`end:${params.chatId}`);
        return { text: "", durationMs: 50, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
      }),
    };

    initDispatcher({
      backend,
      context: { acquire: () => {}, release: () => {}, getMessageCount: () => 0 },
      sendTyping: async () => {},
      onActivity: () => {},
    });

    // Fire two queries for DIFFERENT chats — they should overlap
    await Promise.all([
      execute({ chatId: "A", numericChatId: 1, prompt: "a", senderName: "U", isGroup: false, source: "message" }),
      execute({ chatId: "B", numericChatId: 2, prompt: "b", senderName: "U", isGroup: false, source: "message" }),
    ]);

    // Both should START before either ENDS (true parallel)
    expect(order[0]).toBe("start:A");
    expect(order[1]).toBe("start:B");
  });

  it("second query still runs after first query errors (same chat)", async () => {
    let callCount = 0;
    const backend: QueryBackend = {
      query: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("first fails");
        return { text: "second ok", durationMs: 10, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
      }),
    };

    initDispatcher({
      backend,
      context: { acquire: () => {}, release: () => {}, getMessageCount: () => 0 },
      sendTyping: async () => {},
      onActivity: () => {},
    });

    const p1 = execute({ chatId: "ERR", numericChatId: 1, prompt: "fail", senderName: "U", isGroup: false, source: "message" });
    const p2 = execute({ chatId: "ERR", numericChatId: 1, prompt: "succeed", senderName: "U", isGroup: false, source: "message" });

    await expect(p1).rejects.toThrow("first fails");
    const result = await p2;
    expect(result.text).toBe("second ok");
  });

  it("activeCount is accurate during errors", async () => {
    const backend: QueryBackend = {
      query: vi.fn(async () => { throw new Error("boom"); }),
    };

    initDispatcher({
      backend,
      context: { acquire: () => {}, release: () => {}, getMessageCount: () => 0 },
      sendTyping: async () => {},
      onActivity: () => {},
    });

    await expect(
      execute({ chatId: "X", numericChatId: 1, prompt: "x", senderName: "U", isGroup: false, source: "message" }),
    ).rejects.toThrow("boom");

    expect(getActiveCount()).toBe(0); // cleaned up even on error
  });

  it("cleans up chatChains after queries complete (no map leak)", async () => {
    const backend: QueryBackend = {
      query: vi.fn(async () => ({
        text: "ok",
        durationMs: 10,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      })),
    };

    initDispatcher({
      backend,
      context: { acquire: () => {}, release: () => {}, getMessageCount: () => 0 },
      sendTyping: async () => {},
      onActivity: () => {},
    });

    // Execute queries for two different chats
    await execute({
      chatId: "cleanup-A",
      numericChatId: 100,
      prompt: "a",
      senderName: "U",
      isGroup: false,
      source: "message",
    });
    await execute({
      chatId: "cleanup-B",
      numericChatId: 200,
      prompt: "b",
      senderName: "U",
      isGroup: false,
      source: "message",
    });

    // After both complete, activeCount should be 0 (chains cleaned up)
    expect(getActiveCount()).toBe(0);

    // Execute another query for the same chatId — should work fine (no stale chain)
    const result = await execute({
      chatId: "cleanup-A",
      numericChatId: 100,
      prompt: "c",
      senderName: "U",
      isGroup: false,
      source: "message",
    });
    expect(result.text).toBe("ok");
  });

  it("calls sendTyping at least once during execution", async () => {
    const deps = createMockDeps();
    let resolveQuery!: () => void;
    (deps.backend.query as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<{
          text: string;
          durationMs: number;
          inputTokens: number;
          outputTokens: number;
          cacheRead: number;
          cacheWrite: number;
        }>((r) => {
          resolveQuery = () =>
            r({
              text: "done",
              durationMs: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheRead: 0,
              cacheWrite: 0,
            });
        }),
    );
    initDispatcher(deps);

    const p = execute({
      chatId: "typing-test",
      numericChatId: 777,
      prompt: "hi",
      senderName: "U",
      isGroup: false,
      source: "message",
    });

    // Wait for the initial sendTyping call
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.sendTyping).toHaveBeenCalledWith(777);
    expect(deps.sendTyping.mock.calls.length).toBeGreaterThanOrEqual(1);

    resolveQuery();
    await p;
  });

  it("serializes same-chat queries (FIFO)", async () => {
    const order: string[] = [];
    const backend: QueryBackend = {
      query: vi.fn(async (params) => {
        order.push(`start:${params.text}`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`end:${params.text}`);
        return { text: "", durationMs: 30, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
      }),
    };

    initDispatcher({
      backend,
      context: { acquire: () => {}, release: () => {}, getMessageCount: () => 0 },
      sendTyping: async () => {},
      onActivity: () => {},
    });

    // Fire two queries for the SAME chat — second must wait
    await Promise.all([
      execute({ chatId: "X", numericChatId: 1, prompt: "first", senderName: "U", isGroup: false, source: "message" }),
      execute({ chatId: "X", numericChatId: 1, prompt: "second", senderName: "U", isGroup: false, source: "message" }),
    ]);

    // Same chat: first completes before second starts
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });
});

describe("typing indicator — interval error handling", () => {
  it("logs warning when sendTyping interval callback rejects", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(), logDebug: vi.fn(), logWarn: vi.fn(), logError: vi.fn(),
    }));
    vi.doMock("../core/dream.js", () => ({ maybeStartDream: vi.fn() }));

    const { initDispatcher, execute } = await import("../core/dispatcher.js");
    const { logWarn } = await import("../util/log.js") as { logWarn: ReturnType<typeof vi.fn> };

    let typingCallCount = 0;
    let resolveQuery!: (v: { text: string; durationMs: number; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number }) => void;

    initDispatcher({
      backend: {
        query: vi.fn(() => new Promise((r) => { resolveQuery = r; })),
      },
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {
        typingCallCount++;
        if (typingCallCount > 1) throw new Error("interval typing API error");
      }),
      onActivity: vi.fn(),
    });

    const p = execute({
      chatId: "interval-err",
      numericChatId: 888,
      prompt: "test",
      senderName: "U",
      isGroup: false,
      source: "message",
    });

    // Let the initial sendTyping call run, then trigger the 4000ms interval
    await vi.advanceTimersByTimeAsync(4100);

    resolveQuery({ text: "ok", durationMs: 10, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 });
    await p;

    expect(logWarn).toHaveBeenCalledWith(
      "dispatcher",
      expect.stringContaining("interval failed"),
    );

    vi.useRealTimers();
  });
});

describe("typing indicator — error handling", () => {
  it("logs warning when sendTyping rejects (initial call)", async () => {
    vi.resetModules();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logDebug: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    }));
    vi.doMock("./dream.js", () => ({ maybeStartDream: vi.fn() }));
    vi.doMock("../core/dream.js", () => ({ maybeStartDream: vi.fn() }));

    const { initDispatcher, execute } = await import("../core/dispatcher.js");
    const logWarn = (await import("../util/log.js")).logWarn as ReturnType<typeof vi.fn>;

    const backend = {
      query: vi.fn(async () => ({ text: "ok", durationMs: 10, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 })),
    };

    initDispatcher({
      backend,
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => { throw new Error("typing API error"); }),
      onActivity: vi.fn(),
    });

    await execute({
      chatId: "typing-err-chat",
      numericChatId: 999,
      prompt: "test",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(logWarn).toHaveBeenCalledWith(
      "dispatcher",
      expect.stringContaining("sendTyping failed"),
    );
  });
});
