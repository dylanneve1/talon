/**
 * Test for the handler-level progress watchdog. The handler iterates the
 * SDK query; if no SDK message arrives for WATCHDOG_MS, it should call
 * qi.interrupt() to break the hang.
 *
 * We mock the SDK's query() to return a stuck async iterable (never
 * yields), verify that after enough fake time elapses interrupt() is
 * called, and that the handler throws a meaningful timeout error.
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
  formatFullDatetime: vi.fn(() => "2026-04-17 19:30"),
}));

vi.mock("../util/config.js", () => ({
  rebuildSystemPrompt: vi.fn(),
}));

vi.mock("../core/plugin.js", () => ({
  getPluginPromptAdditions: vi.fn(() => []),
}));

const mockSessionMeta = { sessionId: undefined, turns: 0, usage: {} };
vi.mock("../storage/sessions.js", () => ({
  getSession: vi.fn(() => mockSessionMeta),
  incrementTurns: vi.fn(),
  recordUsage: vi.fn(),
  resetSession: vi.fn(),
  setSessionId: vi.fn(),
  setSessionName: vi.fn(),
}));

vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: vi.fn(() => ({})),
  setChatModel: vi.fn(),
}));

// The real classify() returns a TalonError (which extends Error) — preserve
// that shape by returning the original Error when given one, so the handler's
// `throw classified` propagates an Error we can assert on.
vi.mock("../core/errors.js", () => ({
  classify: vi.fn((err) =>
    err instanceof Error
      ? Object.assign(err, { reason: "unknown", retryable: false })
      : Object.assign(new Error(String(err)), {
          reason: "unknown",
          retryable: false,
        }),
  ),
}));

vi.mock("../core/models.js", () => ({
  getFallbackModel: vi.fn(() => null),
}));

vi.mock("../backend/claude-sdk/state.js", () => ({
  getConfig: vi.fn(() => ({ workspace: "/tmp" })),
}));

vi.mock("../backend/claude-sdk/options.js", () => ({
  buildSdkOptions: vi.fn(() => ({
    options: { model: "claude-opus-4-6" },
    activeModel: "claude-opus-4-6",
  })),
}));

vi.mock("../backend/claude-sdk/stream.js", () => ({
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
  isSystemInit: () => false,
  isStreamEvent: () => false,
  isAssistant: () => false,
  isResult: () => false,
  processStreamDelta: vi.fn(),
  processAssistantMessage: vi.fn(),
  processResultMessage: vi.fn(),
}));

// Stuck query: iterator.next() never resolves on its own, but we give
// interrupt() a hook that flips the iterator to done=true so the handler's
// iterateStream loop can exit cleanly after the watchdog fires. That way
// the test waits on a real settled promise instead of leaking an in-flight
// handler + unreachable setTimeout on the vitest worker.
let iteratorResolved = false;
let stuckResolve: (r: IteratorResult<unknown>) => void = () => {};

const interruptMock = vi.fn(async () => {
  iteratorResolved = true;
  stuckResolve({ value: undefined, done: true });
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    return {
      interrupt: interruptMock,
      [Symbol.asyncIterator]: () => ({
        next: () =>
          iteratorResolved
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise<IteratorResult<unknown>>((resolve) => {
                stuckResolve = resolve;
              }),
      }),
    };
  }),
}));

beforeEach(() => {
  interruptMock.mockClear();
  iteratorResolved = false;
  stuckResolve = () => {};
});

describe("handler progress watchdog", () => {
  it("fires watchdog, calls interrupt, and rejects with a timeout error", async () => {
    vi.useFakeTimers();
    const { handleMessage } = await import("../backend/claude-sdk/handler.js");

    const p = handleMessage({
      chatId: "wd-chat",
      text: "hello",
      senderName: "Dylan",
      isGroup: false,
    });
    // Stop the promise from floating as unhandled while we advance timers —
    // we re-await at the end for the actual assertion.
    const settled = p.catch((err: unknown) => err);

    // Watchdog polls every 30s, fires at 5 min of silence. Advance 6 min.
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    vi.useRealTimers();

    // The watchdog's Promise.race() rejects independently of the iterator
    // unblocking, so we get a settled rejection every time.
    const err = (await settled) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/timed out after.*of SDK silence/);
    expect(interruptMock).toHaveBeenCalledTimes(1);
  });
});
