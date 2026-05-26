/**
 * Integration test: dispatcher → backend (mocked) → result.
 * Tests the full query lifecycle without spawning actual SDK processes.
 */

import { describe, it, expect, vi } from "vitest";
import { initDispatcher, execute } from "../core/dispatcher.js";
import type { ContextManager } from "../core/types.js";
import { stubBackend, stubResolveActiveModel } from "./helpers/stub-backend.js";
import { TalonError } from "../core/errors.js";

function setup(
  overrides: { queryResult?: Record<string, unknown>; queryError?: Error } = {},
) {
  const acquired: number[] = [];
  const released: number[] = [];
  const typingCalls: number[] = [];
  let activityCount = 0;

  const query = vi.fn(async () => {
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
  });
  const backend = stubBackend({ query });

  const context: ContextManager = {
    acquire: vi.fn((id: number) => acquired.push(id)),
    release: vi.fn((id: number) => released.push(id)),
    getMessageCount: vi.fn(() => 0),
  };

  initDispatcher({
    getBackend: () => backend,
    resolveActiveModel: stubResolveActiveModel(),
    context,
    sendTyping: vi.fn(async (id: number) => {
      typingCalls.push(id);
    }),
    onActivity: vi.fn(() => {
      activityCount++;
    }),
  });

  return {
    backend,
    query,
    context,
    acquired,
    released,
    typingCalls,
    getActivityCount: () => activityCount,
  };
}

describe("integration: dispatcher lifecycle", () => {
  it("full happy path: acquire → type → query → activity → release", async () => {
    const { query, acquired, released, typingCalls, getActivityCount } =
      setup();

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
    expect(query).toHaveBeenCalledWith(
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
      // The dispatcher now consumes the backend's `AgentEvent` stream
      // and pipes events through the legacy bridge — errors arrive
      // wrapped as `BridgedAgentError` carrying the canonical
      // `AgentError`. The classification is preserved through the
      // wrapper.
      const { BridgedAgentError } =
        await import("../core/agent-runtime/event-bridge.js");
      expect(err).toBeInstanceOf(BridgedAgentError);
      const bridged = err as InstanceType<typeof BridgedAgentError>;
      expect(bridged.kind).toBe("rate_limit");
      expect(bridged.retryable).toBe(true);
    }

    expect(released).toEqual([789]);
  });

  it("cross-chat parallel execution", async () => {
    const order: string[] = [];
    const backend = stubBackend({
      query: vi.fn(async (params) => {
        order.push(`start:${params.chatId}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end:${params.chatId}`);
        return {
          text: "",
          durationMs: 20,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }),
    });

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

    // Fire two queries simultaneously
    await Promise.all([
      execute({
        chatId: "A",
        numericChatId: 1,
        prompt: "a",
        senderName: "U",
        isGroup: false,
        source: "message",
      }),
      execute({
        chatId: "B",
        numericChatId: 2,
        prompt: "b",
        senderName: "U",
        isGroup: false,
        source: "message",
      }),
    ]);

    // True concurrency — both start before either ends
    expect(order[0]).toBe("start:A");
    expect(order[1]).toBe("start:B");
  });

  it("stream callbacks are invoked from the backend's event stream", async () => {
    // The dispatcher consumes `backend.chat.runChatTurn` and pipes
    // events back through the legacy callback shape via
    // `pipeEventsToCallbacks`. The caller-supplied
    // `onStreamDelta` / `onTextBlock` callbacks fire whenever the
    // stream produces `text_delta` / `assistant_message` — not
    // because they're forwarded to the SDK directly. This test
    // verifies the round-trip: a backend that emits text via its
    // streaming callbacks → events → caller callbacks.
    const { backend } = setup();
    const onStreamDelta = vi.fn();
    const onTextBlock = vi.fn();
    // Override the backend's chat slot with one that emits text via
    // the wrapped legacy callbacks (handlerToEvents relays them as
    // text_delta events).
    backend.chat!.runChatTurn = (params) =>
      (async function* () {
        yield { type: "run_started" };
        yield { type: "text_delta", text: "hello" };
        yield { type: "assistant_message", text: "hello world" };
        yield {
          type: "usage",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
            modelId: params.model.id,
          },
        };
        yield {
          type: "completed",
          result: {
            text: "hello world",
            durationMs: 1,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            modelId: params.model.id,
          },
        };
      })();

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

    expect(onStreamDelta).toHaveBeenCalled();
    expect(onTextBlock).toHaveBeenCalledWith("hello world");
  });
});
