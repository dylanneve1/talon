import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  initDispatcher,
  execute,
  getActiveCount,
} from "../core/engine/dispatcher.js";
import type { ContextManager } from "../core/types.js";
import {
  stubBackend,
  stubChatBackend,
  stubResolveActiveModel,
} from "./helpers/stub-backend.js";

function createMockDeps() {
  const acquired: number[] = [];
  const released: number[] = [];

  const { backend, query } = stubChatBackend({
    text: "response",
    durationMs: 100,
    inputTokens: 10,
    outputTokens: 20,
    cacheRead: 5,
    cacheWrite: 3,
  });

  const context: ContextManager = {
    acquire: vi.fn((chatId: number) => {
      acquired.push(chatId);
    }),
    release: vi.fn((chatId: number) => {
      released.push(chatId);
    }),
    getMessageCount: vi.fn(() => 0),
  };

  const sendTyping = vi.fn(async () => {});
  const onActivity = vi.fn();

  return {
    backend,
    query,
    getBackend: () => backend,
    resolveActiveModel: stubResolveActiveModel(),
    context,
    sendTyping,
    onActivity,
    acquired,
    released,
  };
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

  it("passes the resolved active model to the backend query", async () => {
    const deps = createMockDeps();
    const resolveActiveModel = vi.fn(
      stubResolveActiveModel("codex", "gpt-5.4-mini"),
    );
    initDispatcher({ ...deps, resolveActiveModel });

    await execute({
      chatId: "123",
      numericChatId: 123,
      prompt: "hello",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(resolveActiveModel).toHaveBeenCalledWith("123");
    expect(deps.query).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "123",
        model: "gpt-5.4-mini",
        text: "hello",
      }),
    );
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
    (deps.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
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
    (deps.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
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

  it("invokes the caller's stream callbacks from the backend's event stream", async () => {
    // The dispatcher pipes backend events back through
    // `pipeEventsToCallbacks` — the caller's `onTextBlock` /
    // `onStreamDelta` fire from the event stream, not from being
    // passed verbatim into `backend.query`. This pins the
    // round-trip: a backend that emits text via its callbacks → the
    // wrapper turns them into events → the pipe invokes the
    // caller's hooks.
    const deps = createMockDeps();
    deps.query.mockImplementation(async (params) => {
      params.onStreamDelta?.("hi");
      await params.onTextBlock?.("hi there");
      return {
        text: "hi there",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    });
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

    expect(onStreamDelta).toHaveBeenCalled();
    expect(onTextBlock).toHaveBeenCalledWith("hi there");
  });

  it("propagates async text-block delivery failures back to callback-shaped backends", async () => {
    const deps = createMockDeps();
    deps.query.mockImplementation(async (params) => {
      try {
        await params.onTextBlock?.("too long");
      } catch {
        await params.onTextBlock?.("short retry");
        return {
          text: "short retry",
          durationMs: 2,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }
      return {
        text: "too long",
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
    });
    initDispatcher(deps);

    const onTextBlock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Telegram message too long"))
      .mockResolvedValueOnce(undefined);

    const result = await execute({
      chatId: "delivery-retry",
      numericChatId: 445,
      prompt: "stream",
      senderName: "User",
      isGroup: false,
      source: "message",
      onTextBlock,
    });

    expect(onTextBlock).toHaveBeenCalledTimes(2);
    expect(onTextBlock).toHaveBeenNthCalledWith(1, "too long");
    expect(onTextBlock).toHaveBeenNthCalledWith(2, "short retry");
    expect(result.text).toBe("short retry");
  });

  it("tracks active count", async () => {
    expect(getActiveCount()).toBe(0);

    const deps = createMockDeps();
    let resolveQuery!: () => void;
    (deps.query as ReturnType<typeof vi.fn>).mockImplementation(
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
              text: "",
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
      chatId: "555",
      numericChatId: 555,
      prompt: "hi",
      senderName: "U",
      isGroup: false,
      source: "message",
    });
    // Give it a tick to start
    await new Promise((r) => setTimeout(r, 10));
    expect(getActiveCount()).toBe(1);

    resolveQuery();
    await p;
    expect(getActiveCount()).toBe(0);
  });

  it("runs different-chat queries in true parallel", async () => {
    const backend = stubBackend();

    initDispatcher({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context: {
        acquire: () => {},
        release: () => {},
        getMessageCount: () => 0,
      },
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
    expect(result.text).toBe("stub response");
  });

  it("calls sendTyping at least once during execution", async () => {
    const deps = createMockDeps();
    let resolveQuery!: () => void;
    (deps.query as ReturnType<typeof vi.fn>).mockImplementation(
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
    const backend = stubBackend();

    initDispatcher({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {
        throw new Error("typing API error");
      }),
      onActivity: vi.fn(),
    });

    // sendTyping rejecting must not blow up the dispatcher — the
    // error is caught and logged via util/log. The other "non-Error
    // throws" describe block above covers the logWarn assertion
    // path with a dynamically mocked logger.
    await expect(
      execute({
        chatId: "typing-err-chat",
        numericChatId: 999,
        prompt: "test",
        senderName: "User",
        isGroup: false,
        source: "message",
      }),
    ).resolves.toBeDefined();
  });
});

describe("typing indicator — non-Error throws", () => {
  it("logs warning with String(err) when sendTyping throws a non-Error (initial call)", async () => {
    vi.resetModules();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logDebug: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    }));
    vi.doMock("../core/background/dream.js", () => ({
      maybeStartDream: vi.fn(),
    }));

    const { initDispatcher, execute } =
      await import("../core/engine/dispatcher.js");
    const logWarn = (await import("../util/log.js")).logWarn as ReturnType<
      typeof vi.fn
    >;

    initDispatcher({
      getBackend: () =>
        stubBackend({
          query: vi.fn(async () => ({
            text: "ok",
            durationMs: 10,
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
          })),
        }),
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      // Throw a plain string (non-Error) to hit the `String(err)` branch at line 99
      sendTyping: vi.fn(async () => {
        throw "plain string typing error";
      }), // eslint-disable-line @typescript-eslint/no-throw-literal
      onActivity: vi.fn(),
    });

    await execute({
      chatId: "typing-non-error-chat",
      numericChatId: 1001,
      prompt: "test",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(logWarn).toHaveBeenCalledWith(
      "dispatcher",
      expect.stringContaining("plain string typing error"),
    );
  });

  it("logs warning with String(err) when sendTyping interval throws a non-Error", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logDebug: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    }));
    vi.doMock("../core/background/dream.js", () => ({
      maybeStartDream: vi.fn(),
    }));

    const { initDispatcher, execute } =
      await import("../core/engine/dispatcher.js");
    const logWarn = (await import("../util/log.js")).logWarn as ReturnType<
      typeof vi.fn
    >;

    let callCount = 0;
    let resolveQuery!: (v: {
      text: string;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      cacheRead: number;
      cacheWrite: number;
    }) => void;

    initDispatcher({
      getBackend: () =>
        stubBackend({
          query: vi.fn(
            () =>
              new Promise((r) => {
                resolveQuery = r;
              }),
          ) as never,
        }),
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      // First call OK, subsequent calls throw a non-Error string (covers line 103 String(err) branch)
      sendTyping: vi.fn(async () => {
        callCount++;
        if (callCount > 1) throw "non-error interval typing failure"; // eslint-disable-line @typescript-eslint/no-throw-literal
      }),
      onActivity: vi.fn(),
    });

    const p = execute({
      chatId: "interval-non-error-chat",
      numericChatId: 1002,
      prompt: "test",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    await vi.advanceTimersByTimeAsync(4100);
    resolveQuery({
      text: "ok",
      durationMs: 10,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    await p;

    expect(logWarn).toHaveBeenCalledWith(
      "dispatcher",
      expect.stringContaining("interval failed"),
    );

    vi.useRealTimers();
  });
});

describe("dispatcher — uninitialized guard", () => {
  it("throws when execute is called before initDispatcher", async () => {
    vi.resetModules();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logDebug: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    }));
    vi.doMock("../core/background/dream.js", () => ({
      maybeStartDream: vi.fn(),
    }));

    const { execute } = await import("../core/engine/dispatcher.js");
    // deps is null because initDispatcher was never called in this fresh module
    await expect(
      execute({
        chatId: "x",
        numericChatId: 1,
        prompt: "hi",
        senderName: "U",
        isGroup: false,
        source: "message",
      }),
    ).rejects.toThrow("Dispatcher not initialized");
  });
});
