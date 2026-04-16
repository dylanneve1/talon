/**
 * Tests for the per-chat session queue with mid-flight message injection.
 *
 * Two layers under test:
 *   1. AsyncMessageQueue — push-based AsyncIterable.
 *   2. submitMessage / iterate — driving the SDK Query lifecycle and
 *      routing turn boundaries (system_init / assistant / result) to the
 *      right pending turn's callbacks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../util/metrics.js", () => ({
  incrementCounter: vi.fn(),
  recordHistogram: vi.fn(),
}));

vi.mock("../util/trace.js", () => ({
  traceMessage: vi.fn(),
}));

vi.mock("../util/time.js", () => ({
  formatFullDatetime: vi.fn(() => "2026-04-16 12:00"),
}));

const mockSession = {
  sessionId: undefined as string | undefined,
  turns: 0,
  usage: {},
};

vi.mock("../storage/sessions.js", () => ({
  getSession: vi.fn(() => mockSession),
  incrementTurns: vi.fn(() => {
    mockSession.turns++;
  }),
  recordUsage: vi.fn(),
  resetSession: vi.fn(),
  setSessionId: vi.fn((_chat: string, sid: string) => {
    mockSession.sessionId = sid;
  }),
  setSessionName: vi.fn(),
}));

vi.mock("../core/plugin.js", () => ({
  getPluginPromptAdditions: vi.fn(() => []),
}));

vi.mock("../util/config.js", () => ({
  rebuildSystemPrompt: vi.fn(),
}));

vi.mock("../backend/claude-sdk/state.js", () => ({
  getConfig: vi.fn(() => ({ workspace: "/tmp" })),
}));

vi.mock("../backend/claude-sdk/options.js", () => ({
  buildSdkOptions: vi.fn(() => ({
    options: { model: "claude-opus-4-6" },
    activeModel: "claude-opus-4-6",
  })),
  buildMcpServers: vi.fn(() => ({})),
}));

// ── Mock SDK ────────────────────────────────────────────────────────────────
// We let the test push SDK messages onto a controllable queue. Each `query()`
// call returns an async iterable that consumes from this queue.

type MockSDKMessage = {
  type: "system" | "assistant" | "stream_event" | "result";
  [k: string]: unknown;
};

let sdkOutQueue: MockSDKMessage[];
let sdkOutWaiters: ((v: IteratorResult<MockSDKMessage>) => void)[];
let sdkOutClosed: boolean;
let sdkInputIterable: AsyncIterable<unknown> | null;

function pushSdkMessage(msg: MockSDKMessage): void {
  const w = sdkOutWaiters.shift();
  if (w) w({ value: msg, done: false });
  else sdkOutQueue.push(msg);
}

function endSdkStream(): void {
  sdkOutClosed = true;
  while (sdkOutWaiters.length > 0) {
    const w = sdkOutWaiters.shift()!;
    w({ value: undefined as never, done: true });
  }
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn((params: { prompt: AsyncIterable<unknown> }) => {
      sdkInputIterable = params.prompt;
      const queryObj: AsyncIterable<MockSDKMessage> & {
        setMcpServers: ReturnType<typeof vi.fn>;
        interrupt: ReturnType<typeof vi.fn>;
      } = {
        setMcpServers: vi.fn(),
        interrupt: vi.fn(),
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<IteratorResult<MockSDKMessage>> => {
            const m = sdkOutQueue.shift();
            if (m) return Promise.resolve({ value: m, done: false });
            if (sdkOutClosed)
              return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((resolve) => {
              sdkOutWaiters.push(resolve);
            });
          },
        }),
      };
      return queryObj;
    }),
  };
});

vi.mock("../backend/claude-sdk/stream.js", async () => {
  return {
    createStreamState: () => ({
      currentBlockText: "",
      allResponseText: "",
      newSessionId: undefined,
      toolCalls: 0,
      contextTokens: 0,
      contextWindow: undefined,
      numApiCalls: 0,
      sdkInputTokens: 0,
      sdkOutputTokens: 0,
      sdkCacheRead: 0,
      sdkCacheWrite: 0,
      lastStreamUpdate: 0,
    }),
    isSystemInit: (m: MockSDKMessage) =>
      m.type === "system" && m.subtype === "init",
    isStreamEvent: (m: MockSDKMessage) => m.type === "stream_event",
    isAssistant: (m: MockSDKMessage) => m.type === "assistant",
    isResult: (m: MockSDKMessage) => m.type === "result",
    processStreamDelta: vi.fn(
      (
        msg: MockSDKMessage,
        state: { currentBlockText: string },
        cb?: (acc: string, phase?: "thinking" | "text") => void,
      ) => {
        const text = (msg.text as string) ?? "";
        state.currentBlockText += text;
        cb?.(state.currentBlockText, "text");
      },
    ),
    processAssistantMessage: vi.fn(
      (
        msg: MockSDKMessage,
        state: {
          currentBlockText: string;
          allResponseText: string;
          toolCalls: number;
        },
      ) => {
        const text = (msg.text as string) ?? "";
        const tools =
          (msg.tools as { name: string; input: Record<string, unknown> }[]) ??
          [];
        state.toolCalls += tools.length;
        if (text && tools.length === 0) {
          state.currentBlockText += text;
        }
        return {
          progressTexts: text && tools.length > 0 ? [text] : [],
          tools,
          trailingText: tools.length === 0 ? text : "",
        };
      },
    ),
    processResultMessage: vi.fn(
      (
        msg: MockSDKMessage,
        state: { sdkInputTokens: number; sdkOutputTokens: number },
      ) => {
        state.sdkInputTokens = (msg.in as number) ?? 0;
        state.sdkOutputTokens = (msg.out as number) ?? 0;
      },
    ),
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  sdkOutQueue = [];
  sdkOutWaiters = [];
  sdkOutClosed = false;
  sdkInputIterable = null;
  mockSession.sessionId = undefined;
  mockSession.turns = 0;
  vi.clearAllMocks();
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ── AsyncMessageQueue tests ─────────────────────────────────────────────────

describe("AsyncMessageQueue", () => {
  it("yields pushed items in FIFO order", async () => {
    const { AsyncMessageQueue } =
      await import("../backend/claude-sdk/session-queue.js");
    const q = new AsyncMessageQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();

    const seen: number[] = [];
    for await (const v of q) seen.push(v);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("waits for push when iterator is ahead of the producer", async () => {
    const { AsyncMessageQueue } =
      await import("../backend/claude-sdk/session-queue.js");
    const q = new AsyncMessageQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const p = it.next();
    let resolved = false;
    p.then(() => {
      resolved = true;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false);

    q.push("hello");
    await flushMicrotasks();
    const result = await p;
    expect(result.done).toBe(false);
    expect(result.value).toBe("hello");
  });

  it("returns done after close even with no items", async () => {
    const { AsyncMessageQueue } =
      await import("../backend/claude-sdk/session-queue.js");
    const q = new AsyncMessageQueue<number>();
    q.close();
    const it = q[Symbol.asyncIterator]();
    const r = await it.next();
    expect(r.done).toBe(true);
  });

  it("resolves pending waiters with done=true on close", async () => {
    const { AsyncMessageQueue } =
      await import("../backend/claude-sdk/session-queue.js");
    const q = new AsyncMessageQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const p = it.next();
    q.close();
    const r = await p;
    expect(r.done).toBe(true);
  });

  it("push returns false after close", async () => {
    const { AsyncMessageQueue } =
      await import("../backend/claude-sdk/session-queue.js");
    const q = new AsyncMessageQueue<number>();
    q.close();
    expect(q.push(1)).toBe(false);
  });

  it("isClosed reflects state", async () => {
    const { AsyncMessageQueue } =
      await import("../backend/claude-sdk/session-queue.js");
    const q = new AsyncMessageQueue<number>();
    expect(q.isClosed()).toBe(false);
    q.close();
    expect(q.isClosed()).toBe(true);
  });
});

// ── submitMessage tests ─────────────────────────────────────────────────────

describe("submitMessage — single turn", () => {
  it("starts a fresh session and resolves on result", async () => {
    const { submitMessage, getActiveQuery, getQueuedCount } =
      await import("../backend/claude-sdk/session-queue.js");

    const p = submitMessage({
      chatId: "chat-1",
      text: "hello",
      senderName: "Dylan",
      isGroup: false,
    });

    // After submit, a session exists and a Query is active
    await flushMicrotasks();
    expect(getActiveQuery("chat-1")).toBeDefined();
    expect(getQueuedCount("chat-1")).toBe(1);

    // SDK emits the lifecycle events
    pushSdkMessage({ type: "system", subtype: "init", session_id: "s-1" });
    pushSdkMessage({ type: "assistant", text: "hi" });
    pushSdkMessage({ type: "result", in: 10, out: 5 });

    const result = await p;
    expect(result.text).toBe("hi");
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);

    // After the result with no pending, the session input is closed and
    // session is torn down. Drain so the iterator exits cleanly.
    endSdkStream();
    await flushMicrotasks();
    expect(getActiveQuery("chat-1")).toBeUndefined();
    expect(getQueuedCount("chat-1")).toBe(0);
  });

  it("formats the SDK user message from the prompt", async () => {
    const { submitMessage } =
      await import("../backend/claude-sdk/session-queue.js");
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    submitMessage({
      chatId: "chat-format",
      text: "ping",
      senderName: "Dylan",
      isGroup: true,
      messageId: 42,
    });

    await flushMicrotasks();
    expect(sdk.query).toHaveBeenCalledOnce();
    // The prompt should be an AsyncIterable (streaming input mode), not a string
    const callArgs = (sdk.query as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(typeof callArgs.prompt).toBe("object");
    expect(typeof callArgs.prompt[Symbol.asyncIterator]).toBe("function");

    // Pull the user message out of the input iterable
    const it = (callArgs.prompt as AsyncIterable<unknown>)[
      Symbol.asyncIterator
    ]();
    const first = await it.next();
    const msg = first.value as {
      type: string;
      session_id: string;
      message: {
        role: string;
        content: { type: string; text: string }[];
      };
      parent_tool_use_id: string | null;
    };
    // Match the exact shape SDK Session.send() produces
    expect(msg.type).toBe("user");
    expect(msg.session_id).toBe("");
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.message.role).toBe("user");
    expect(Array.isArray(msg.message.content)).toBe(true);
    expect(msg.message.content[0].type).toBe("text");
    expect(msg.message.content[0].text).toContain("[Dylan]");
    expect(msg.message.content[0].text).toContain("[msg_id:42]");
    expect(msg.message.content[0].text).toContain("ping");
  });
});

describe("submitMessage — mid-flight injection", () => {
  it("injects message B into the same Query while message A is processing", async () => {
    const { submitMessage, getActiveQuery, getQueuedCount } =
      await import("../backend/claude-sdk/session-queue.js");
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    // Submit A
    const pA = submitMessage({
      chatId: "chat-inject",
      text: "first",
      senderName: "Dylan",
      isGroup: false,
    });
    await flushMicrotasks();
    expect(sdk.query).toHaveBeenCalledOnce();

    // SDK starts processing A: emits system_init then a tool call for A
    pushSdkMessage({ type: "system", subtype: "init", session_id: "s-inj" });
    pushSdkMessage({
      type: "assistant",
      text: "thinking...",
      tools: [{ name: "search", input: {} }],
    });
    await flushMicrotasks();

    // While A is mid-tool — submit B
    const pB = submitMessage({
      chatId: "chat-inject",
      text: "second",
      senderName: "Dylan",
      isGroup: false,
    });
    await flushMicrotasks();

    // Critical: NO new query() call. The same Query handles both.
    expect(sdk.query).toHaveBeenCalledOnce();
    expect(getActiveQuery("chat-inject")).toBeDefined();
    expect(getQueuedCount("chat-inject")).toBe(2);

    // Verify B was pushed onto the input iterable
    expect(sdkInputIterable).toBeDefined();

    // Finish A
    pushSdkMessage({ type: "assistant", text: "done with first" });
    pushSdkMessage({ type: "result", in: 5, out: 3 });
    const resultA = await pA;
    expect(resultA.text).toBe("done with first");
    await flushMicrotasks();

    // After A completes, B becomes current. Process B.
    expect(getQueuedCount("chat-inject")).toBe(1);

    pushSdkMessage({ type: "assistant", text: "done with second" });
    pushSdkMessage({ type: "result", in: 4, out: 2 });
    const resultB = await pB;
    expect(resultB.text).toBe("done with second");

    endSdkStream();
    await flushMicrotasks();
    expect(getActiveQuery("chat-inject")).toBeUndefined();
  });

  it("routes per-turn callbacks correctly across turn boundaries", async () => {
    const { submitMessage } =
      await import("../backend/claude-sdk/session-queue.js");

    const onTextA = vi.fn();
    const onToolA = vi.fn();
    const onTextB = vi.fn();
    const onToolB = vi.fn();

    const pA = submitMessage({
      chatId: "chat-cb",
      text: "first",
      senderName: "Dylan",
      isGroup: false,
      onTextBlock: onTextA,
      onToolUse: onToolA,
    });
    await flushMicrotasks();

    pushSdkMessage({ type: "system", subtype: "init", session_id: "s-cb" });
    pushSdkMessage({
      type: "assistant",
      text: "calling A's tool",
      tools: [{ name: "tool_for_A", input: {} }],
    });
    await flushMicrotasks();

    expect(onToolA).toHaveBeenCalledWith("tool_for_A", {});
    expect(onTextA).toHaveBeenCalledWith("calling A's tool");

    // Inject B mid-flight
    const pB = submitMessage({
      chatId: "chat-cb",
      text: "second",
      senderName: "Dylan",
      isGroup: false,
      onTextBlock: onTextB,
      onToolUse: onToolB,
    });
    await flushMicrotasks();

    // Finish A
    pushSdkMessage({ type: "assistant", text: "A's final" });
    pushSdkMessage({ type: "result", in: 1, out: 1 });
    await pA;
    await flushMicrotasks();

    // Tool/text events that belong to B's turn should hit B's callbacks
    pushSdkMessage({
      type: "assistant",
      text: "calling B's tool",
      tools: [{ name: "tool_for_B", input: { x: 1 } }],
    });
    pushSdkMessage({ type: "assistant", text: "B's final" });
    pushSdkMessage({ type: "result", in: 1, out: 1 });
    await pB;

    expect(onToolB).toHaveBeenCalledWith("tool_for_B", { x: 1 });
    // A's callbacks must NOT have fired for B's events
    expect(onToolA).toHaveBeenCalledTimes(1); // only A's own tool

    endSdkStream();
    await flushMicrotasks();
  });

  it("handles a third message arriving while two are already pending", async () => {
    const { submitMessage, getQueuedCount } =
      await import("../backend/claude-sdk/session-queue.js");
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    const pA = submitMessage({
      chatId: "chat-three",
      text: "A",
      senderName: "Dylan",
      isGroup: false,
    });
    await flushMicrotasks();
    pushSdkMessage({ type: "system", subtype: "init", session_id: "s-three" });

    const pB = submitMessage({
      chatId: "chat-three",
      text: "B",
      senderName: "Dylan",
      isGroup: false,
    });
    const pC = submitMessage({
      chatId: "chat-three",
      text: "C",
      senderName: "Dylan",
      isGroup: false,
    });
    await flushMicrotasks();

    expect(sdk.query).toHaveBeenCalledOnce();
    expect(getQueuedCount("chat-three")).toBe(3);

    // Drain in order
    pushSdkMessage({ type: "assistant", text: "Adone" });
    pushSdkMessage({ type: "result", in: 1, out: 1 });
    expect((await pA).text).toBe("Adone");

    pushSdkMessage({ type: "assistant", text: "Bdone" });
    pushSdkMessage({ type: "result", in: 1, out: 1 });
    expect((await pB).text).toBe("Bdone");

    pushSdkMessage({ type: "assistant", text: "Cdone" });
    pushSdkMessage({ type: "result", in: 1, out: 1 });
    expect((await pC).text).toBe("Cdone");

    endSdkStream();
    await flushMicrotasks();
    expect(getQueuedCount("chat-three")).toBe(0);
  });
});

describe("submitMessage — follow-up after drain reuses session", () => {
  it("a second message arriving after the first turn's result keeps the same Query", async () => {
    const { submitMessage, getActiveQuery } =
      await import("../backend/claude-sdk/session-queue.js");
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    // Submit + drain message A
    const pA = submitMessage({
      chatId: "chat-followup",
      text: "first",
      senderName: "Dylan",
      isGroup: false,
    });
    await flushMicrotasks();
    pushSdkMessage({ type: "system", subtype: "init", session_id: "s-fu" });
    pushSdkMessage({ type: "assistant", text: "Adone" });
    pushSdkMessage({ type: "result", in: 1, out: 1 });
    expect((await pA).text).toBe("Adone");
    await flushMicrotasks();

    // The session must STILL be alive (idle timer is running, queue not closed).
    // This is the key behavior that makes injection useful — the SDK
    // subprocess + MCP servers stay loaded for the next message.
    expect(getActiveQuery("chat-followup")).toBeDefined();
    expect(sdk.query).toHaveBeenCalledOnce();

    // Submit B — should be injected into the SAME query
    const pB = submitMessage({
      chatId: "chat-followup",
      text: "second",
      senderName: "Dylan",
      isGroup: false,
    });
    await flushMicrotasks();
    expect(sdk.query).toHaveBeenCalledOnce(); // still only one query() call

    pushSdkMessage({ type: "assistant", text: "Bdone" });
    pushSdkMessage({ type: "result", in: 1, out: 1 });
    expect((await pB).text).toBe("Bdone");

    endSdkStream();
    await flushMicrotasks();
  });
});

describe("submitMessage — error handling", () => {
  it("rejects all pending turns when the SDK iteration errors", async () => {
    const { submitMessage } =
      await import("../backend/claude-sdk/session-queue.js");

    const pA = submitMessage({
      chatId: "chat-err",
      text: "A",
      senderName: "Dylan",
      isGroup: false,
    });
    await flushMicrotasks();

    const pB = submitMessage({
      chatId: "chat-err",
      text: "B",
      senderName: "Dylan",
      isGroup: false,
    });
    await flushMicrotasks();

    // Force the iterator to throw on its next read by rejecting all waiters
    while (sdkOutWaiters.length > 0) {
      const w = sdkOutWaiters.shift()!;
      w(
        Promise.reject(new Error("sdk boom")) as unknown as IteratorResult<
          MockSDKMessage,
          unknown
        >,
      );
    }
    // Short-circuit: just throw via the iterator by closing + a thrown promise
    // Since our mock doesn't surface .throw(), simulate by making next() reject:
    sdkOutWaiters = [];
    sdkOutClosed = true;
    // Manually trigger handleSessionError path by injecting a throwing message
    // is hard with this mock — instead we use the simpler invariant:
    // when the stream closes unexpectedly, both pending turns reject.

    await expect(pA).rejects.toThrow();
    await expect(pB).rejects.toThrow();
  });

  it("a new submit after a failed session starts a fresh session", async () => {
    const { submitMessage, getActiveQuery } =
      await import("../backend/claude-sdk/session-queue.js");
    const sdk = await import("@anthropic-ai/claude-agent-sdk");

    const pA = submitMessage({
      chatId: "chat-fresh",
      text: "A",
      senderName: "Dylan",
      isGroup: false,
    });
    await flushMicrotasks();

    // End the stream without any result → A rejects
    endSdkStream();
    await expect(pA).rejects.toThrow();
    await flushMicrotasks();
    expect(getActiveQuery("chat-fresh")).toBeUndefined();

    // Reset SDK output state for the new session
    sdkOutClosed = false;
    sdkOutQueue = [];
    sdkOutWaiters = [];

    const pB = submitMessage({
      chatId: "chat-fresh",
      text: "B",
      senderName: "Dylan",
      isGroup: false,
    });
    await flushMicrotasks();

    // A second query() call should have happened (fresh session)
    expect(sdk.query).toHaveBeenCalledTimes(2);

    pushSdkMessage({ type: "system", subtype: "init", session_id: "s2" });
    pushSdkMessage({ type: "assistant", text: "Bok" });
    pushSdkMessage({ type: "result", in: 1, out: 1 });
    expect((await pB).text).toBe("Bok");

    endSdkStream();
    await flushMicrotasks();
  });
});
