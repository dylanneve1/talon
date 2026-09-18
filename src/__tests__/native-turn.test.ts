/**
 * What a Companion client sees while a turn runs — the happy path of the
 * native bridge's turn loop.
 *
 * `startTurn` drives `dispatcher.execute()` and forwards the canonical agent
 * event stream to clients as bridge events, so the dispatcher is the seam
 * that gets stubbed: each test hands it a scripted event list plus a result
 * and asserts on what the recording broadcast sink saw. Failure, queueing
 * and interrupt live in native-turn-control.test.ts.
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
vi.mock("../frontend/native/context.js", () => ({
  refreshContext: vi.fn(async () => {}),
}));

import type { AgentEvent } from "../core/agent-runtime/events.js";
import { getBackendForChat } from "../core/engine/backend-controller/index.js";
import { execute } from "../core/engine/dispatcher.js";
import type { ExecuteParams, ExecuteResult } from "../core/types.js";
import { refreshContext } from "../frontend/native/context.js";
import { emitPhoto } from "../frontend/native/emit.js";
import { getTurnMeta } from "../frontend/native/turn-meta.js";
import { startTurn } from "../frontend/native/turn.js";
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

let harness: ReturnType<typeof makeNativeHarness>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBackendForChat).mockReturnValue(null as never);
  vi.mocked(refreshContext).mockResolvedValue(undefined);
  harness = makeNativeHarness();
});

describe("native turn — events reaching the client", () => {
  it("emits the user's message before the turn opens", async () => {
    const { runtime, events } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([]);
    startTurn(runtime, entry, "hello there");
    await settle();

    const first = events.find((e) => e.kind === "message");
    expect(first).toMatchObject({
      kind: "message",
      chatId: entry.id,
      message: { role: "user", text: "hello there" },
    });
  });

  it("opens the turn with turn_start and a typing indicator", async () => {
    const { runtime, events } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([]);
    startTurn(runtime, entry, "hi");
    await settle();

    expect(events.filter((e) => e.kind === "turn_start")).toEqual([
      { kind: "turn_start", chatId: entry.id },
    ]);
  });

  it("forwards assistant text deltas as delta events", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([
      { type: "text_delta", text: "par" },
      { type: "text_delta", text: "tial" },
    ]);
    startTurn(runtime, entry, "hi");
    await settle();

    expect(eventsOf("delta").map((e) => e.text)).toEqual(["par", "tial"]);
  });

  it("forwards reasoning, but drops an empty reasoning event", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([
      { type: "reasoning", text: "thinking" },
      { type: "reasoning", text: "" },
    ]);
    startTurn(runtime, entry, "hi");
    await settle();

    expect(eventsOf("reasoning").map((e) => e.text)).toEqual(["thinking"]);
  });

  it("streams a tool call and its result with the summarized output", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([
      { type: "tool_call", id: "t1", name: "Read", input: { path: "/x" } },
      { type: "tool_result", id: "t1", name: "Read", result: "file body" },
    ]);
    startTurn(runtime, entry, "read it");
    await settle();

    expect(eventsOf("tool")).toEqual([
      {
        kind: "tool",
        chatId: entry.id,
        id: "t1",
        name: "Read",
        phase: "call",
        input: { path: "/x" },
      },
      {
        kind: "tool",
        chatId: entry.id,
        id: "t1",
        name: "Read",
        phase: "result",
        output: "file body",
      },
    ]);
  });

  it("carries a failed tool's error into the result event", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([
      { type: "tool_call", id: "t1", name: "Bash", input: {} },
      { type: "tool_result", id: "t1", name: "Bash", error: "exit 1" },
    ]);
    startTurn(runtime, entry, "run it");
    await settle();

    expect(eventsOf("tool")[1]).toMatchObject({
      phase: "result",
      error: "exit 1",
    });
  });

  it("keeps delivery plumbing out of the tool timeline", async () => {
    // send_message's effect arrives as the `message` itself — showing it as a
    // tool too would double-report every reply.
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([
      { type: "tool_call", id: "d1", name: "send_message", input: {} },
      { type: "tool_result", id: "d1", name: "send_message", result: "ok" },
    ]);
    startTurn(runtime, entry, "say hi");
    await settle();

    expect(eventsOf("tool")).toHaveLength(0);
  });

  it("surfaces an agent error event to the chat", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([
      { type: "error", error: new Error("model refused") as never },
    ]);
    startTurn(runtime, entry, "hi");
    await settle();

    expect(eventsOf("error")).toEqual([
      { kind: "error", chatId: entry.id, message: "model refused" },
    ]);
  });

  it("gives an unresolved tool a synthetic result so its spinner closes", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([
      { type: "tool_call", id: "orphan", name: "Grep", input: {} },
    ]);
    startTurn(runtime, entry, "search");
    await settle();

    expect(eventsOf("tool").map((e) => e.phase)).toEqual(["call", "result"]);
  });

  it("closes the turn with its duration and token usage", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([]);
    startTurn(runtime, entry, "hi");
    await settle();

    expect(eventsOf("turn_end")).toEqual([
      {
        kind: "turn_end",
        chatId: entry.id,
        delivered: 1,
        durationMs: 42,
        usage: { input: 11, output: 7 },
      },
    ]);
  });

  it("stops the typing indicator when the turn ends", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([]);
    startTurn(runtime, entry, "hi");
    await settle();

    expect(eventsOf("typing").map((e) => e.on)).toEqual([true, false]);
  });

  it("delivers a photo the agent sent as an assistant message with a media url", () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    emitPhoto(runtime, entry, "/tmp/shot.png", "  look  ");

    const message = eventsOf("message")[0]!.message;
    expect(message).toMatchObject({ role: "assistant", text: "look" });
    expect(message.imagePath).toMatch(/^\/media\?id=/);
  });
});

describe("native turn — delivery and persistence", () => {
  it("delivers trailing prose when no delivery tool fired", async () => {
    // Text-mode backends (kilo/opencode/codex) reply as plain text.
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits(
      [],
      result({ text: "  the answer  ", bridgeMessageCount: 0 }),
    );
    startTurn(runtime, entry, "question");
    await settle();

    expect(
      eventsOf("message")
        .map((e) => e.message)
        .filter((m) => m.role === "assistant"),
    ).toMatchObject([{ text: "the answer" }]);
  });

  it("does not re-deliver text a delivery tool already sent", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits(
      [],
      result({ text: "already sent", bridgeMessageCount: 1 }),
    );
    startTurn(runtime, entry, "question");
    await settle();

    expect(
      eventsOf("message").filter((e) => e.message.role === "assistant"),
    ).toHaveLength(0);
  });

  it("records the turn's tools and stats against its assistant message", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits(
      [
        { type: "tool_call", id: "t1", name: "Read", input: { path: "/x" } },
        { type: "tool_result", id: "t1", name: "Read", result: "body" },
      ],
      result({ text: "done", bridgeMessageCount: 0 }),
    );
    startTurn(runtime, entry, "read it");
    await settle();

    const msgId = runtime.lastAssistantId.get(entry.id)!;
    expect(getTurnMeta(entry.id, msgId)).toMatchObject({
      durationMs: 42,
      tokensIn: 11,
      tokensOut: 7,
      tools: [{ id: "t1", name: "Read" }],
    });
  });

  it("records no turn meta when the turn delivered nothing", async () => {
    // The "last assistant id" would belong to a previous turn, so the meta
    // would land on the wrong row.
    const { runtime } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([], result({ text: "   ", bridgeMessageCount: 0 }));
    startTurn(runtime, entry, "hi");
    await settle();

    expect(runtime.lastAssistantId.has(entry.id)).toBe(false);
  });

  it("hands the dispatcher the chat's numeric id and the user message id", async () => {
    const { runtime, eventsOf } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([]);
    startTurn(runtime, entry, "hi");
    await settle();

    const userId = Number(eventsOf("message")[0]!.message.id);
    expect(vi.mocked(execute).mock.calls[0]![0]).toMatchObject({
      chatId: entry.id,
      numericChatId: entry.numericId,
      prompt: "hi",
      senderName: "User",
      isGroup: false,
      messageId: userId,
      source: "message",
    });
  });

  it("points the model at the files the user attached", async () => {
    const { runtime } = harness;
    const entry = runtime.chats.create();
    dispatcherEmits([]);
    startTurn(runtime, entry, "look", {
      attachments: [
        {
          path: "/uploads/a.png",
          name: "a.png",
          size: 10,
          mimeType: "image/png",
          url: "/media?id=a",
          image: true,
        },
      ],
    });
    await settle();

    expect(vi.mocked(execute).mock.calls[0]![0]!.prompt).toBe(
      "look\n\n[Attached image: /uploads/a.png]",
    );
  });
});
