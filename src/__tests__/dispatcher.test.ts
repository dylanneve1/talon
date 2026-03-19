import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDispatcher, execute, isBusy } from "../core/dispatcher.js";
import type { QueryBackend, ContextManager } from "../core/types.js";

function createMockDeps() {
  const acquired: string[] = [];
  const released: string[] = [];

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
    acquire: vi.fn((chatId: string) => { acquired.push(chatId); }),
    release: vi.fn((chatId: string) => { released.push(chatId); }),
    isBusy: vi.fn(() => acquired.length > released.length),
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
      prompt: "test",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(deps.context.acquire).toHaveBeenCalledWith("456");
    expect(deps.context.release).toHaveBeenCalledWith("456");
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
        prompt: "fail",
        senderName: "User",
        isGroup: false,
        source: "message",
      }),
    ).rejects.toThrow("boom");

    expect(deps.context.release).toHaveBeenCalledWith("789");
  });

  it("sends typing on execution", async () => {
    const deps = createMockDeps();
    initDispatcher(deps);

    await execute({
      chatId: "111",
      prompt: "hi",
      senderName: "User",
      isGroup: false,
      source: "message",
    });

    expect(deps.sendTyping).toHaveBeenCalledWith("111");
  });

  it("calls onActivity after successful query", async () => {
    const deps = createMockDeps();
    initDispatcher(deps);

    await execute({
      chatId: "222",
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

  it("isBusy delegates to context manager", () => {
    const deps = createMockDeps();
    (deps.context.isBusy as ReturnType<typeof vi.fn>).mockReturnValue(true);
    initDispatcher(deps);
    expect(isBusy()).toBe(true);
  });
});
