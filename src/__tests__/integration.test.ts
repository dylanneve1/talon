/**
 * Integration test: dispatcher → backend (mocked) → result.
 * Tests the full query lifecycle without spawning actual SDK processes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDispatcher, execute, isBusy, getQueueSize } from "../core/dispatcher.js";
import type { QueryBackend, ContextManager } from "../core/types.js";
import { TalonError } from "../core/errors.js";

function setup(overrides: { queryResult?: Record<string, unknown>; queryError?: Error } = {}) {
  const acquired: number[] = [];
  const released: number[] = [];
  const typingCalls: number[] = [];
  let activityCount = 0;

  const backend: QueryBackend = {
    query: vi.fn(async () => {
      if (overrides.queryError) throw overrides.queryError;
      return {
        text: "test response",
        durationMs: 50,
        inputTokens: 10,
        outputTokens: 20,
        cacheRead: 5,
        cacheWrite: 3,
        ...overrides.queryResult,
      };
    }),
  };

  const context: ContextManager = {
    acquire: vi.fn((id: number) => acquired.push(id)),
    release: vi.fn((id: number) => released.push(id)),
    isBusy: vi.fn(() => acquired.length > released.length),
    getMessageCount: vi.fn(() => 0),
  };

  initDispatcher({
    backend,
    context,
    sendTyping: vi.fn(async (id: number) => { typingCalls.push(id); }),
    onActivity: vi.fn(() => { activityCount++; }),
    concurrency: 1,
  });

  return { backend, context, acquired, released, typingCalls, getActivityCount: () => activityCount };
}

describe("integration: dispatcher lifecycle", () => {
  it("full happy path: acquire → type → query → activity → release", async () => {
    const { backend, context, acquired, released, typingCalls, getActivityCount } = setup();

    const result = await execute({
      chatId: "123",
      numericChatId: 123,
      prompt: "hello world",
      senderName: "TestUser",
      isGroup: false,
      source: "message",
    });

    expect(result.text).toBe("test response");
    expect(result.durationMs).toBe(50);
    expect(result.bridgeMessageCount).toBe(0);

    // Context lifecycle
    expect(acquired).toEqual([123]);
    expect(released).toEqual([123]);

    // Typing was sent
    expect(typingCalls).toEqual([123]);

    // Activity callback fired
    expect(getActivityCount()).toBe(1);

    // Backend was called with correct params
    expect(backend.query).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "123",
        text: "hello world",
        senderName: "TestUser",
        isGroup: false,
      }),
    );
  });

  it("error path: context released even on failure", async () => {
    const { released } = setup({ queryError: new Error("SDK crashed") });

    await expect(
      execute({
        chatId: "456",
        numericChatId: 456,
        prompt: "will fail",
        senderName: "User",
        isGroup: false,
        source: "message",
      }),
    ).rejects.toThrow("SDK crashed");

    expect(released).toEqual([456]);
  });

  it("classified error path: TalonError propagated", async () => {
    const { released } = setup({
      queryError: new TalonError("rate limited", {
        reason: "rate_limit",
        retryable: true,
        retryAfterMs: 5000,
      }),
    });

    try {
      await execute({
        chatId: "789",
        numericChatId: 789,
        prompt: "will rate limit",
        senderName: "User",
        isGroup: false,
        source: "message",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TalonError);
      const te = err as TalonError;
      expect(te.reason).toBe("rate_limit");
      expect(te.retryable).toBe(true);
    }

    expect(released).toEqual([789]);
  });

  it("sequential execution with concurrency=1", async () => {
    const order: string[] = [];
    const backend: QueryBackend = {
      query: vi.fn(async (params) => {
        order.push(`start:${params.chatId}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end:${params.chatId}`);
        return { text: "", durationMs: 20, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
      }),
    };

    initDispatcher({
      backend,
      context: {
        acquire: () => {},
        release: () => {},
        isBusy: () => false,
        getMessageCount: () => 0,
      },
      sendTyping: async () => {},
      onActivity: () => {},
      concurrency: 1,
    });

    // Fire two queries simultaneously
    const [r1, r2] = await Promise.all([
      execute({ chatId: "A", numericChatId: 1, prompt: "a", senderName: "U", isGroup: false, source: "message" }),
      execute({ chatId: "B", numericChatId: 2, prompt: "b", senderName: "U", isGroup: false, source: "message" }),
    ]);

    // With concurrency=1, they should execute sequentially
    expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  it("stream callbacks are passed through to backend", async () => {
    const { backend } = setup();
    const onStreamDelta = vi.fn();
    const onTextBlock = vi.fn();

    await execute({
      chatId: "999",
      numericChatId: 999,
      prompt: "stream test",
      senderName: "User",
      isGroup: true,
      source: "pulse",
      onStreamDelta,
      onTextBlock,
    });

    expect(backend.query).toHaveBeenCalledWith(
      expect.objectContaining({
        onStreamDelta,
        onTextBlock,
        isGroup: true,
      }),
    );
  });
});
