import { describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../backend/kilo/server.js", () => ({
  ensureServer: vi.fn(async () => {
    throw new Error(
      "ensureServer should not be called from kilo-summary tests",
    );
  }),
  getConfig: vi.fn(() => undefined),
  initKiloAgent: vi.fn(),
  stopKiloServer: vi.fn(),
}));

const { summarizeKiloAssistantMessages } =
  await import("../backend/kilo/index.js");

const { extractPartsSummary, extractAssistantUsage } =
  await import("../backend/kilo/sessions.js");

// ---------------------------------------------------------------------------
// extractPartsSummary — pulls assistant text + tool-call count out of the raw
// SDK `parts` array. Used by handler.ts on every turn. The "text" path
// concatenates with "\n\n" between blocks; "tool" parts contribute to the
// toolCalls count but not the text.
// ---------------------------------------------------------------------------
describe("extractPartsSummary", () => {
  it("returns empty text and zero tool calls for an empty parts array", () => {
    expect(extractPartsSummary([])).toEqual({ text: "", toolCalls: 0 });
  });

  it("joins multiple text parts with a blank-line separator", () => {
    const summary = extractPartsSummary([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
    expect(summary.text).toBe("hello\n\nworld");
    expect(summary.toolCalls).toBe(0);
  });

  it("counts tool parts but excludes them from text", () => {
    const summary = extractPartsSummary([
      { type: "text", text: "before" },
      { type: "tool", name: "read_file", input: { path: "/etc/hosts" } },
      { type: "tool", name: "write_file" },
      { type: "text", text: "after" },
    ]);
    expect(summary.text).toBe("before\n\nafter");
    expect(summary.toolCalls).toBe(2);
  });

  it("ignores text parts where .text is not a string (SDK shape guard)", () => {
    const summary = extractPartsSummary([
      { type: "text", text: "real" },
      { type: "text" }, // missing .text
      { type: "text", text: null }, // non-string .text
      { type: "text", text: 42 }, // numeric .text
    ]);
    expect(summary.text).toBe("real");
  });

  it("ignores parts with unknown types (reasoning, etc) — only text + tool count", () => {
    // The handler only surfaces text and counts tool calls. Reasoning
    // blocks and any future part type are silently passed over.
    const summary = extractPartsSummary([
      { type: "reasoning", content: "thinking..." },
      { type: "step-start" },
      { type: "text", text: "done" },
    ]);
    expect(summary.text).toBe("done");
    expect(summary.toolCalls).toBe(0);
  });

  it("trims trailing whitespace on the final text", () => {
    // The final .trim() means a part array with only whitespace yields "".
    expect(extractPartsSummary([{ type: "text", text: "  " }]).text).toBe("");
    expect(extractPartsSummary([{ type: "text", text: "\n\n" }]).text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractAssistantUsage — coerces an OpenCodeAssistantInfo into a flat usage
// record. Used as the fallback when the turn-summary path can't find any
// assistant messages. Must never throw on partial data.
// ---------------------------------------------------------------------------
describe("extractAssistantUsage", () => {
  it("returns all-zero usage for undefined info", () => {
    expect(extractAssistantUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      providerID: undefined,
      modelID: undefined,
    });
  });

  it("returns all-zero usage for info with no token data", () => {
    expect(extractAssistantUsage({ role: "assistant" })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      providerID: undefined,
      modelID: undefined,
    });
  });

  it("pulls every defined field through cleanly when info is complete", () => {
    expect(
      extractAssistantUsage({
        role: "assistant",
        providerID: "kilo",
        modelID: "big-pickle",
        cost: 0.1234,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 5,
          cache: { read: 10, write: 20 },
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheRead: 10,
      cacheWrite: 20,
      costUsd: 0.1234,
      providerID: "kilo",
      modelID: "big-pickle",
    });
  });

  it("treats missing cache.read/write as zero (cache subobject optional)", () => {
    // SDK responses for some providers omit the cache subobject entirely.
    const usage = extractAssistantUsage({
      tokens: { input: 5, output: 6 },
    });
    expect(usage.cacheRead).toBe(0);
    expect(usage.cacheWrite).toBe(0);
  });

  it("preserves providerID/modelID even when token data is missing", () => {
    // Useful for the fallback path: even an empty assistant chunk should
    // carry forward what model produced it so recordUsage(...) doesn't lose
    // the model label.
    expect(
      extractAssistantUsage({
        providerID: "openrouter",
        modelID: "inclusionai/ling-2.6-1t:free",
      }),
    ).toMatchObject({
      providerID: "openrouter",
      modelID: "inclusionai/ling-2.6-1t:free",
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("Kilo assistant summaries", () => {
  it("aggregates usage across the full assistant chain for a turn", () => {
    const summary = summarizeKiloAssistantMessages(
      [
        {
          info: {
            role: "assistant",
            modelID: "big-pickle",
            providerID: "kilo",
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
            providerID: "kilo",
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
    const summary = summarizeKiloAssistantMessages([
      {
        info: {
          role: "assistant",
          modelID: "nemotron-3-super-free",
          providerID: "kilo",
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
          providerID: "kilo",
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

  it("filters out user / system / tool-role messages", () => {
    const summary = summarizeKiloAssistantMessages([
      {
        info: { role: "user", time: { created: 50 } },
        parts: [{ type: "text", text: "hi" }],
      },
      {
        info: { role: "system", time: { created: 60 } },
        parts: [{ type: "text", text: "policy" }],
      },
      {
        info: {
          role: "assistant",
          modelID: "x",
          providerID: "kilo",
          time: { created: 70, completed: 80 },
          tokens: { input: 5, output: 6 },
        },
        parts: [{ type: "text", text: "ok" }],
      },
    ]);

    expect(summary.usage.assistantMessages).toBe(1);
    expect(summary.usage.inputTokens).toBe(5);
    expect(summary.usage.outputTokens).toBe(6);
  });

  it("honours the minCreatedAt cutoff for prior-turn assistant messages", () => {
    const summary = summarizeKiloAssistantMessages(
      [
        {
          info: {
            role: "assistant",
            modelID: "x",
            providerID: "kilo",
            time: { created: 100, completed: 110 },
            tokens: { input: 1, output: 1 },
            cost: 0.1,
          },
          parts: [{ type: "text", text: "prior turn" }],
        },
        {
          info: {
            role: "assistant",
            modelID: "x",
            providerID: "kilo",
            time: { created: 300, completed: 310 },
            tokens: { input: 9, output: 9 },
            cost: 0.9,
          },
          parts: [{ type: "text", text: "current turn" }],
        },
      ],
      200,
    );

    expect(summary.usage.assistantMessages).toBe(1);
    expect(summary.usage.inputTokens).toBe(9);
    expect(summary.usage.outputTokens).toBe(9);
    expect(summary.latestAssistant?.createdAt).toBe(300);
  });
});
