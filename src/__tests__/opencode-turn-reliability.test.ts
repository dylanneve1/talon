import { describe, expect, it, vi } from "vitest";

import { runOpenCodeTurn } from "../backend/opencode/handler/turn.js";
import { createStreamState } from "../backend/shared/index.js";

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
});
