import { describe, expect, it, vi } from "vitest";

import { runOpenCodeTurn } from "../backend/opencode/handler/turn.js";
import { createStreamState } from "../backend/shared/index.js";
import {
  awaitRemoteTurn,
  RemoteTurnTimeoutError,
} from "../backend/remote-server/turn-timeout.js";
import { subscribeSseStream } from "../backend/remote-server/sse-stream.js";

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

    await runOpenCodeTurn({
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
