/**
 * Handler silence watchdog — if the SDK stops emitting messages for
 * WATCHDOG_MS, the handler should call qi.interrupt() and reject with
 * a clear timeout error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("../util/trace.js", () => ({ traceMessage: vi.fn() }));
vi.mock("../util/time.js", () => ({
  formatFullDatetime: () => "2026-04-20 22:30",
}));
vi.mock("../util/config.js", () => ({ rebuildSystemPrompt: vi.fn() }));
vi.mock("../core/plugin.js", () => ({ getPluginPromptAdditions: () => [] }));

const sessionMeta = { sessionId: undefined, turns: 0, usage: {} };
vi.mock("../storage/sessions.js", () => ({
  getSession: () => sessionMeta,
  incrementTurns: vi.fn(),
  recordUsage: vi.fn(),
  resetSession: vi.fn(),
  setSessionId: vi.fn(),
  setSessionName: vi.fn(),
}));
vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: () => ({}),
  setChatModel: vi.fn(),
}));
vi.mock("../core/errors.js", () => ({
  classify: (err: unknown) =>
    err instanceof Error
      ? Object.assign(err, { reason: "unknown", retryable: false })
      : Object.assign(new Error(String(err)), {
          reason: "unknown",
          retryable: false,
        }),
}));
vi.mock("../core/models.js", () => ({ getFallbackModel: () => null }));
vi.mock("../backend/claude-sdk/state.js", () => ({
  getConfig: () => ({ workspace: "/tmp" }),
}));
vi.mock("../backend/claude-sdk/options.js", () => ({
  buildSdkOptions: () => ({
    options: { model: "claude-opus-4-6" },
    activeModel: "claude-opus-4-6",
  }),
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

// A stuck async iterator that never yields. interrupt() flips it to done
// so the iterate promise can settle and the handler's finally block runs
// — otherwise the Vitest worker would leak an in-flight promise.
let resolveDone: (v: IteratorResult<unknown>) => void = () => {};
let doneFlag = false;
const interruptMock = vi.fn(async () => {
  doneFlag = true;
  resolveDone({ value: undefined, done: true });
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => ({
    interrupt: interruptMock,
    [Symbol.asyncIterator]: () => ({
      next: () =>
        doneFlag
          ? Promise.resolve({ value: undefined, done: true })
          : new Promise<IteratorResult<unknown>>((resolve) => {
              resolveDone = resolve;
            }),
    }),
  })),
}));

describe("handler silence watchdog", () => {
  beforeEach(() => {
    interruptMock.mockClear();
    doneFlag = false;
    resolveDone = () => {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("interrupts the query and rejects after sustained silence", async () => {
    vi.useFakeTimers();
    const { handleMessage } = await import("../backend/claude-sdk/handler.js");

    const pending = handleMessage({
      chatId: "wd-test",
      text: "hi",
      senderName: "User",
      isGroup: false,
    });
    // Swallow the rejection locally so advancing timers doesn't produce an
    // unhandled promise warning.
    const settled = pending.catch((err: unknown) => err);

    // Watchdog polls every 30s, fires at 5 min. Advance 6 min in 30s ticks.
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    const err = (await settled) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/stalled.*no SDK activity/);
    expect(interruptMock).toHaveBeenCalledTimes(1);
  });
});
