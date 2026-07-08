import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievedMemory } from "../core/agent-runtime/capabilities.js";
import {
  AgentRunError,
  type AgentEvent,
} from "../core/agent-runtime/events.js";
import { makeBareModelRef } from "../core/agent-runtime/model-ref.js";
import {
  carryTurnEvents,
  prefetchMemory,
  resolveWarp,
  startTypingLoop,
} from "../core/weaver/index.js";

async function* stream(...events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const event of events) yield event;
}

describe("shuttle", () => {
  it("forwards events in stream order and captures the completed result", async () => {
    const seen: string[] = [];
    const result = await carryTurnEvents(
      stream(
        { type: "text_delta", text: "he" },
        { type: "assistant_message", text: "hello" },
        {
          type: "completed",
          result: {
            text: "hello",
            durationMs: 5,
            usage: {
              inputTokens: 1,
              outputTokens: 2,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        },
      ),
      async (event) => {
        seen.push(event.type);
      },
    );

    expect(seen).toEqual(["text_delta", "assistant_message", "completed"]);
    expect(result?.text).toBe("hello");
    expect(result?.usage.outputTokens).toBe(2);
  });

  it("settles deliveryAck: resolve on sink success, reject on sink throw", async () => {
    const resolved = vi.fn();
    const rejected = vi.fn();

    await carryTurnEvents(
      stream({
        type: "assistant_message",
        text: "ok",
        deliveryAck: { resolve: resolved, reject: rejected },
      }),
      async () => {},
    );
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();

    const failure = new Error("send failed");
    await carryTurnEvents(
      stream({
        type: "assistant_message",
        text: "ok",
        deliveryAck: { resolve: resolved, reject: rejected },
      }),
      async () => {
        throw failure;
      },
    );
    expect(rejected).toHaveBeenCalledWith(failure);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("resolves deliveryAck even when no sink is supplied", async () => {
    const resolved = vi.fn();
    await carryTurnEvents(
      stream({
        type: "assistant_message",
        text: "ok",
        deliveryAck: { resolve: resolved, reject: vi.fn() },
      }),
    );
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("rethrows an error terminator as AgentRunError after forwarding it", async () => {
    const seen: string[] = [];
    await expect(
      carryTurnEvents(
        stream({
          type: "error",
          error: { kind: "rate_limit", message: "limited", retryable: false },
        }),
        async (event) => {
          seen.push(event.type);
        },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AgentRunError);
      expect((err as AgentRunError).kind).toBe("rate_limit");
      expect((err as AgentRunError).retryable).toBe(false);
      return true;
    });
    expect(seen).toEqual(["error"]);
  });
});

describe("warp resolver", () => {
  const chatRef = makeBareModelRef("claude", "chat-model", "discovered");
  const input = { chatId: "c", source: "message", reqId: "test" };

  it("binds the chat's resolved model when no override is set", async () => {
    const warp = await resolveWarp(
      {
        resolveActiveModel: async () => ({
          model: "chat-model",
          ref: chatRef,
          backendId: "claude",
        }),
      },
      input,
    );
    expect(warp).toEqual({
      ok: true,
      ref: chatRef,
      backendId: "claude",
      overridden: false,
    });
  });

  it("refuses the turn with a /model prompt when no model resolves", async () => {
    const warp = await resolveWarp(
      {
        resolveActiveModel: async () => ({
          model: null,
          ref: null,
          backendId: "kilo",
        }),
      },
      input,
    );
    expect(warp.ok).toBe(false);
    if (!warp.ok) {
      expect(warp.backendId).toBe("kilo");
      expect(warp.message).toContain("No model selected");
      expect(warp.message).toContain("backendDefaults.kilo");
    }
  });

  it("applies a resolvable per-run override and flags it", async () => {
    const overrideRef = makeBareModelRef("claude", "cheap-model", "discovered");
    const warp = await resolveWarp(
      {
        resolveActiveModel: async () => ({
          model: "chat-model",
          ref: chatRef,
          backendId: "claude",
        }),
        resolveModelOverride: async () => overrideRef,
      },
      { ...input, modelOverride: "cheap-model" },
    );
    expect(warp).toEqual({
      ok: true,
      ref: overrideRef,
      backendId: "claude",
      overridden: true,
    });
  });

  it.each([
    ["unresolvable", async (): Promise<null> => null],
    [
      "throwing",
      async (): Promise<null> => {
        throw new Error("catalog changed");
      },
    ],
  ] as const)(
    "falls back to the chat model on a %s override",
    async (_label, resolveModelOverride) => {
      const warp = await resolveWarp(
        {
          resolveActiveModel: async () => ({
            model: "chat-model",
            ref: chatRef,
            backendId: "claude",
          }),
          resolveModelOverride,
        },
        { ...input, modelOverride: "stale-model" },
      );
      expect(warp).toEqual({
        ok: true,
        ref: chatRef,
        backendId: "claude",
        overridden: false,
      });
    },
  );
});

describe("typing loop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends immediately, refreshes on the interval, and stops cleanly", () => {
    vi.useFakeTimers();
    const sendTyping = vi.fn(async () => {});

    const stop = startTypingLoop(sendTyping, 7, "chat", 4000);
    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(sendTyping).toHaveBeenCalledWith(7, "chat");

    vi.advanceTimersByTime(8000);
    expect(sendTyping).toHaveBeenCalledTimes(3);

    stop();
    vi.advanceTimersByTime(8000);
    expect(sendTyping).toHaveBeenCalledTimes(3);
  });

  it("swallows send failures instead of failing the turn", async () => {
    vi.useFakeTimers();
    const sendTyping = vi.fn(async () => {
      throw new Error("indicator dropped");
    });

    const stop = startTypingLoop(sendTyping, 7, "chat", 4000);
    await vi.advanceTimersByTimeAsync(4000);
    stop();
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });
});

describe("memory prefetch", () => {
  const input = {
    chatId: "c",
    text: "hello",
    senderName: "Dylan",
    isGroup: false,
    reqId: "test",
  };

  it("returns the retriever's result", async () => {
    const memory: RetrievedMemory = {
      source: "mempalace",
      query: "hello",
      items: [],
    };
    await expect(prefetchMemory(async () => memory, input)).resolves.toBe(
      memory,
    );
  });

  it("fails closed when the retriever throws", async () => {
    await expect(
      prefetchMemory(async () => {
        throw new Error("palace on fire");
      }, input),
    ).resolves.toBeUndefined();
  });
});
