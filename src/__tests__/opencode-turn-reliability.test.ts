import { afterEach, describe, expect, it, vi } from "vitest";

import { runRemoteTurn } from "../backend/remote-server/turn.js";
import { createStreamState } from "../backend/shared/index.js";
import {
  awaitRemoteTurn,
  RemoteTurnTimeoutError,
} from "../backend/remote-server/turn-timeout.js";
import { subscribeSseStream } from "../backend/remote-server/sse-stream.js";
import {
  RemoteServerStoppedError,
  stopRemoteServer,
} from "../backend/remote-server/lifecycle.js";
import { createRemoteServerState } from "../backend/remote-server/state.js";

/** An SSE stream that stays open until the test releases it. */
function gatedEvents(): {
  stream: AsyncGenerator<unknown>;
  release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* stream(): AsyncGenerator<unknown> {
    await gate;
    yield {
      payload: { type: "session.idle", properties: { sessionID: "sess-1" } },
    };
  }
  return { stream: stream(), release };
}

function makeClient(
  stream: AsyncIterable<unknown>,
  questionList = vi.fn(async () => ({ data: [] })),
) {
  return {
    global: { event: vi.fn(async () => ({ stream })) },
    session: {
      abort: vi.fn(async () => ({ data: true })),
      promptAsync: vi.fn(async () => ({ data: true })),
      messages: vi.fn(async () => ({ data: [] })),
    },
    question: { list: questionList, reply: vi.fn(), reject: vi.fn() },
    permission: { list: vi.fn(async () => ({ data: [] })), reply: vi.fn() },
  };
}

function turnInputs(
  oc: ReturnType<typeof makeClient>,
  stopSignal?: AbortSignal,
) {
  return {
    label: "OpenCode",
    oc: oc as never,
    sessionId: "sess-1",
    prompt: "hello",
    systemPrompt: "system",
    providerID: "provider",
    modelID: "model",
    state: createStreamState(),
    chatId: "chat-1",
    seenQuestionIds: new Set<string>(),
    seenPermissionIds: new Set<string>(),
    seenToolCallIds: new Set<string>(),
    stopSignal,
  };
}

async function* turnEvents(): AsyncGenerator<unknown> {
  yield {
    payload: {
      type: "message.part.updated",
      properties: {
        sessionID: "sess-1",
        part: {
          type: "tool",
          callID: "call-1",
          tool: "talon-tools-chat-1_end_turn",
          state: { status: "completed", input: { text: "done" } },
        },
      },
    },
  };
  yield {
    payload: {
      type: "session.idle",
      properties: { sessionID: "sess-1" },
    },
  };
}

describe("OpenCode turn reliability", () => {
  it("does not abort after end_turn and scopes tools on promptAsync", async () => {
    const abort = vi.fn(async () => ({ data: true }));
    const promptAsync = vi.fn(async () => ({ data: true }));
    const oc = {
      global: { event: vi.fn(async () => ({ stream: turnEvents() })) },
      session: {
        abort,
        promptAsync,
        messages: vi.fn(async () => ({ data: [] })),
      },
      question: {
        list: vi.fn(async () => ({ data: [] })),
        reply: vi.fn(),
        reject: vi.fn(),
      },
      permission: {
        list: vi.fn(async () => ({ data: [] })),
        reply: vi.fn(),
      },
    };
    const toolOverrides = {
      "talon-tools-chat-1_end_turn": true,
      "talon-tools-chat-2_end_turn": false,
    };

    await runRemoteTurn({
      label: "OpenCode",
      oc: oc as never,
      sessionId: "sess-1",
      prompt: "hello",
      systemPrompt: "system",
      providerID: "provider",
      modelID: "model",
      state: createStreamState(),
      chatId: "chat-1",
      seenQuestionIds: new Set(),
      seenPermissionIds: new Set(),
      seenToolCallIds: new Set(),
      toolOverrides,
    });

    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ tools: toolOverrides }),
    );
    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts and rejects a remote turn that exceeds its deadline", async () => {
    const abort = vi.fn(async () => ({ data: true }));
    const never = new Promise<void>(() => {});

    await expect(
      awaitRemoteTurn(never, {
        client: { session: { abort } },
        sessionId: "stuck-session",
        chatId: "chat-1",
        label: "OpenCode",
        timeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(RemoteTurnTimeoutError);
    expect(abort).toHaveBeenCalledWith({ sessionID: "stuck-session" });
  });

  it("retries transient SSE subscription failures before giving up", async () => {
    async function* events() {
      yield { payload: { type: "session.idle" } };
    }
    const event = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce({ stream: events() });

    await expect(
      subscribeSseStream({ global: { event } }, "chat-1"),
    ).resolves.toBeDefined();
    expect(event).toHaveBeenCalledTimes(2);
  });
});

describe("remote-server stop while a turn is in flight", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stopRemoteServer aborts every tracked turn with a non-retryable error", () => {
    const state = createRemoteServerState({
      label: "OpenCode",
      hostname: "127.0.0.1",
      port: 9999,
    });
    const first = new AbortController();
    const second = new AbortController();
    state.activeTurns.add(first).add(second);

    stopRemoteServer(state);

    for (const controller of [first, second]) {
      expect(controller.signal.aborted).toBe(true);
      const reason = controller.signal.reason as RemoteServerStoppedError;
      expect(reason).toBeInstanceOf(RemoteServerStoppedError);
      expect(reason.retryable).toBe(false);
      expect(reason.message).toMatch(/OpenCode server stopped/);
    }
    expect(state.activeTurns.size).toBe(0);
  });

  it("rejects the in-flight turn promptly when the stop signal fires", async () => {
    const { stream, release } = gatedEvents();
    const oc = makeClient(stream);
    const stop = new AbortController();

    const turn = runRemoteTurn(turnInputs(oc, stop.signal));
    await vi.waitFor(() => expect(oc.session.promptAsync).toHaveBeenCalled());

    const settled = turn.then(
      () => "resolved" as const,
      (err: unknown) => err,
    );
    stop.abort(new RemoteServerStoppedError("OpenCode"));
    // The SSE socket may never close on its own; the turn must not wait on it.
    const outcome = await Promise.race([
      settled,
      new Promise<"hung">((resolve) =>
        setTimeout(() => resolve("hung"), 1_500),
      ),
    ]);
    release();

    expect(outcome).toBeInstanceOf(RemoteServerStoppedError);
    expect(oc.session.abort).not.toHaveBeenCalled();
  });

  it("question watchdog stops polling after three consecutive failures", async () => {
    vi.useFakeTimers();
    const { stream, release } = gatedEvents();
    const questionList = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const oc = makeClient(stream, questionList);

    const turn = runRemoteTurn(turnInputs(oc));
    // Polls at t=0, 350, 700 all fail; without the cap, 2s would see ~6.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(questionList).toHaveBeenCalledTimes(3);

    release();
    await vi.advanceTimersByTimeAsync(1_500);
    await turn;
    // One final settle runs in the turn's cleanup regardless.
    expect(questionList).toHaveBeenCalledTimes(4);
  });
});
