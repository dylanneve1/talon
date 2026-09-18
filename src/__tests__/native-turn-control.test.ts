/**
 * What the native bridge's turn loop does when a turn does not simply
 * succeed: the dispatcher throws, a second message arrives mid-turn, or the
 * user interrupts.
 *
 * Same stubbed seams as native-turn.test.ts (the dispatcher scripts the
 * turn, a recording sink collects the bridge events). The backend controller
 * is stubbed too — no pool is bound in a unit test, which is exactly the
 * state `interruptTurn` has to tolerate.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/engine/dispatcher.js", () => ({ execute: vi.fn() }));

vi.mock("../core/engine/backend-controller/index.js", () => ({
  getBackendForChat: vi.fn(() => null),
  getBackendIdForChat: vi.fn(() => {
    throw new Error("backend pool not bound");
  }),
}));

// The context readout is a fire-and-forget tail on every turn; stubbing it
// keeps the turn assertions about the turn, and lets one test reject it.
vi.mock("../frontend/native/turn/context.js", () => ({
  refreshContext: vi.fn(async () => {}),
}));

import type { AgentEvent } from "../core/agent-runtime/events.js";
import { getBackendForChat } from "../core/engine/backend-controller/index.js";
import { execute } from "../core/engine/dispatcher.js";
import type { ExecuteParams, ExecuteResult } from "../core/types.js";
import { refreshContext } from "../frontend/native/turn/context.js";
import { setQueued } from "../frontend/native/turn/queue.js";
import {
  interruptTurn,
  isBusy,
  liveTurnEvents,
  startTurn,
} from "../frontend/native/turn/turn.js";
import { makeNativeHarness, settle } from "./helpers/native-bridge.js";

function result(over: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    text: "",
    durationMs: 42,
    inputTokens: 11,
    outputTokens: 7,
    cacheRead: 0,
    cacheWrite: 0,
    bridgeMessageCount: 1,
    ...over,
  };
}

/** Script the dispatcher: replay `events` to the turn, then return `res`. */
function dispatcherEmits(events: AgentEvent[], res = result()): void {
  vi.mocked(execute).mockImplementation(async (params: ExecuteParams) => {
    for (const event of events) await params.onEvent?.(event);
    return res;
  });
}

/** A dispatcher call that only finishes when the returned release is run. */
function dispatcherHangs(res = result()): () => void {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.mocked(execute).mockImplementationOnce(async () => {
    await gate;
    return res;
  });
  return release;
}

let harness: ReturnType<typeof makeNativeHarness>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBackendForChat).mockReturnValue(null as never);
  vi.mocked(refreshContext).mockResolvedValue(undefined);
  harness = makeNativeHarness();
});
describe("native turn — failure and queueing", () => {
  it("turns a dispatcher throw into an error event", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    vi.mocked(execute).mockRejectedValue(new Error("backend died"));
    startTurn(runtime, entry, "hi");
    await settle();

    expect(eventsOf("error")).toEqual([
      { kind: "error", chatId: entry.id, message: "backend died" },
    ]);
  });

  it("ends a thrown turn as delivered: 0 rather than leaving it open", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    vi.mocked(execute).mockRejectedValue("a bare string");
    startTurn(runtime, entry, "hi");
    await settle();

    expect(eventsOf("turn_end")[0]).toMatchObject({ delivered: 0 });
  });

  it("leaves the chat free for the next message after a throw", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    vi.mocked(execute).mockRejectedValue(new Error("backend died"));
    startTurn(runtime, entry, "hi");
    await settle();

    expect(isBusy(runtime, entry.id)).toBe(false);
  });

  it("flushes an open tool spinner when the turn throws", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    vi.mocked(execute).mockImplementation(async (params: ExecuteParams) => {
      await params.onEvent?.({
        type: "tool_call",
        id: "t1",
        name: "Read",
        input: {},
      });
      throw new Error("died mid-tool");
    });
    startTurn(runtime, entry, "hi");
    await settle();

    expect(eventsOf("tool").map((e) => e.phase)).toEqual(["call", "result"]);
  });

  it("swallows a rejected context refresh instead of failing the turn", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    vi.mocked(refreshContext).mockRejectedValue(
      new Error("session read failed"),
    );
    dispatcherEmits([]);
    startTurn(runtime, entry, "hi");
    await settle();

    expect(eventsOf("error")).toHaveLength(0);
    expect(eventsOf("turn_end")).toHaveLength(1);
  });

  it("marks a chat busy while its turn runs", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    const release = dispatcherHangs();
    startTurn(runtime, entry, "hi");
    expect(isBusy(runtime, entry.id)).toBe(true);
    release();
    await settle();
  });

  it("sends a queued follow-up as its own turn once the first ends", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    const release = dispatcherHangs();
    vi.mocked(execute).mockImplementation(async () => result());
    startTurn(runtime, entry, "first");

    setQueued(runtime, entry.id, { text: "second", attachments: [] });
    release();
    await settle(4);

    expect(vi.mocked(execute).mock.calls.map((c) => c[0]!.prompt)).toEqual([
      "first",
      "second",
    ]);
  });

  it("clears the queue when the follow-up is flushed", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    const release = dispatcherHangs();
    vi.mocked(execute).mockImplementation(async () => result());
    startTurn(runtime, entry, "first");
    setQueued(runtime, entry.id, { text: "second", attachments: [] });
    release();
    await settle(4);

    expect(runtime.queuedByChat.has(entry.id)).toBe(false);
  });

  it("replays an in-flight turn's tool activity to a client that just connected", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    let seen: ReturnType<typeof liveTurnEvents> = [];
    vi.mocked(execute).mockImplementationOnce(async (params: ExecuteParams) => {
      await params.onEvent?.({
        type: "tool_call",
        id: "t1",
        name: "Read",
        input: { path: "/x" },
      });
      await params.onEvent?.({
        type: "tool_call",
        id: "t2",
        name: "Grep",
        input: {},
      });
      await params.onEvent?.({
        type: "tool_result",
        id: "t1",
        name: "Read",
        result: "body",
      });
      seen = liveTurnEvents(runtime);
      return result();
    });
    startTurn(runtime, entry, "hi");
    await settle();

    expect(seen.map((e) => e.kind)).toEqual([
      "turn_start",
      "typing",
      "tool",
      "tool",
      "tool",
    ]);
  });

  it("replays nothing once every turn has settled", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([]);
    startTurn(runtime, entry, "hi");
    await settle();

    expect(liveTurnEvents(runtime)).toEqual([]);
  });
});

describe("native turn — interrupt", () => {
  function backendThatInterrupts(answer: boolean | Error) {
    const interruptChatTurn = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    vi.mocked(getBackendForChat).mockReturnValue({
      chat: { interruptChatTurn },
    } as never);
    return interruptChatTurn;
  }

  it("signals the running turn's backend for that chat", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    const interrupt = backendThatInterrupts(true);
    const release = dispatcherHangs();
    startTurn(runtime, entry, "long one");

    await expect(interruptTurn(runtime, entry.id)).resolves.toBe(true);
    expect(interrupt).toHaveBeenCalledWith(entry.id);
    release();
    await settle();
  });

  it("closes the interrupted turn with typing off and turn_end", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    backendThatInterrupts(true);
    const release = dispatcherHangs(result({ bridgeMessageCount: 0 }));
    startTurn(runtime, entry, "long one");
    await interruptTurn(runtime, entry.id);
    release();
    await settle();

    expect(eventsOf("typing").map((e) => e.on)).toEqual([true, false]);
    expect(eventsOf("turn_end")[0]).toMatchObject({ delivered: 0 });
  });

  it("refuses to interrupt a chat with no turn running", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    const interrupt = backendThatInterrupts(true);

    await expect(interruptTurn(runtime, entry.id)).resolves.toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("refuses to interrupt a chat the registry does not know", async () => {
    const { runtime } = harness;
    await expect(interruptTurn(runtime, "d_nope")).resolves.toBe(false);
  });

  it("reports false when the backend cannot interrupt", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    vi.mocked(getBackendForChat).mockReturnValue({ chat: {} } as never);
    const release = dispatcherHangs();
    startTurn(runtime, entry, "long one");

    await expect(interruptTurn(runtime, entry.id)).resolves.toBe(false);
    release();
    await settle();
  });

  it("reports false when no backend is bound to the chat", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    vi.mocked(getBackendForChat).mockImplementation(() => {
      throw new Error("no pool binding");
    });
    const release = dispatcherHangs();
    startTurn(runtime, entry, "long one");

    await expect(interruptTurn(runtime, entry.id)).resolves.toBe(false);
    release();
    await settle();
  });

  it("reports false when the backend's interrupt throws", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    backendThatInterrupts(new Error("no session"));
    const release = dispatcherHangs();
    startTurn(runtime, entry, "long one");

    await expect(interruptTurn(runtime, entry.id)).resolves.toBe(false);
    release();
    await settle();
  });
});
