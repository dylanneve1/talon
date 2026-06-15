/**
 * Functional tests for the **openai-agents** backend through the production
 * dispatcher, driven by a fake OpenAI-compatible `/chat/completions` server via
 * the shared harness.
 *
 * Transport: the `@openai/agents` SDK talks to the injected base URL
 * (`TALON_AGENTS_URL`) in `chat_completions` mode and runs MCP tools as its own
 * stdio subprocesses (so the fake only emits the model's streamed output; the
 * SDK handles the tool round-trip → gateway).
 *
 * Like claude/codex, openai-agents is tool-preferred: it delivers via the
 * `end_turn` MCP tool, not plain text. The fake resolves the real (SDK-mangled)
 * function name from the request's `tools` catalog, so the script just says
 * `end_turn`.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createStubHarness } from "./stub-harness/harness.js";
import { openaiAgentsAdapter } from "./stub-harness/adapters/openai-agents.js";

const harness = createStubHarness(openaiAgentsAdapter(), {
  recordingSeed: 8000,
});

describe("openai-agents backend — stub functional (chat_completions)", () => {
  afterAll(() => harness.teardown());

  it("delivers text via the end_turn MCP tool → gateway send_message", async () => {
    harness.recording.reset();
    const replyText = `openai-agents-text-${Date.now()}`;

    const turn = await harness.runTurn({
      prompt: "say hello",
      turn: {
        responses: [
          // 1st model call: invoke end_turn(text). The SDK runs it (→ gateway),
          // then re-requests; the 2nd call ends the turn with no further tool.
          [{ type: "tool", name: "end_turn", arguments: { text: replyText } }],
          [{ type: "text", text: "" }],
        ],
      },
    });

    expect(
      turn.toolUses.find((t) => t.name.endsWith("end_turn")),
    ).toBeDefined();
    const sends = harness.recording.byAction("send_message");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(sends[0].body.text).toBe(replyText);
  }, 60_000);
});
