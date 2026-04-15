import { describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const { summarizeOpenCodeAssistantMessages } = await import(
  "../backend/opencode/index.js"
);

describe("OpenCode assistant summaries", () => {
  it("aggregates usage across the full assistant chain for a turn", () => {
    const summary = summarizeOpenCodeAssistantMessages(
      [
        {
          info: {
            role: "assistant",
            modelID: "big-pickle",
            providerID: "opencode",
            time: { created: 110, completed: 120 },
            tokens: {
              input: 100,
              output: 20,
              reasoning: 5,
              cache: { read: 1, write: 2 },
            },
            cost: 0.1,
          },
          parts: [{ type: "tool" }],
        },
        {
          info: {
            role: "assistant",
            modelID: "big-pickle",
            providerID: "opencode",
            time: { created: 121, completed: 140 },
            tokens: {
              input: 150,
              output: 30,
              reasoning: 7,
              cache: { read: 3, write: 4 },
            },
            cost: 0.2,
          },
          parts: [{ type: "text", text: "done" }],
        },
      ],
      100,
    );

    expect(summary.usage.assistantMessages).toBe(2);
    expect(summary.usage.inputTokens).toBe(250);
    expect(summary.usage.outputTokens).toBe(50);
    expect(summary.usage.reasoningTokens).toBe(12);
    expect(summary.usage.cacheRead).toBe(4);
    expect(summary.usage.cacheWrite).toBe(6);
    expect(summary.usage.costUsd).toBeCloseTo(0.3);
    expect(summary.latestAssistant?.createdAt).toBe(121);
  });

  it("ignores incomplete placeholder assistant messages when selecting the latest snapshot", () => {
    const summary = summarizeOpenCodeAssistantMessages([
      {
        info: {
          role: "assistant",
          modelID: "nemotron-3-super-free",
          providerID: "opencode",
          time: { created: 200, completed: 230 },
          finish: "stop",
          tokens: {
            input: 400,
            output: 40,
            reasoning: 10,
            cache: { read: 0, write: 0 },
          },
          cost: 0,
        },
        parts: [{ type: "text", text: "final" }],
      },
      {
        info: {
          role: "assistant",
          modelID: "nemotron-3-super-free",
          providerID: "opencode",
          time: { created: 240, completed: undefined },
          finish: undefined,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          cost: 0,
        },
        parts: [],
      },
    ]);

    expect(summary.latestAssistant?.createdAt).toBe(200);
    expect(summary.usage.assistantMessages).toBe(1);
    expect(summary.usage.inputTokens).toBe(400);
    expect(summary.usage.outputTokens).toBe(40);
  });
});
