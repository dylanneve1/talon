/**
 * Unit tests for the shared `backend/remote-server/session-helpers.ts`.
 *
 * These cover the pure helpers that both Kilo and OpenCode session
 * modules delegate to:
 *
 *   - `extractPartsSummary` — parts walk + synthetic detection.
 *   - `extractAssistantUsage` — token / cost extraction.
 *   - `summarizeAssistantMessages` — message-batch aggregation.
 *   - `listSessionMessages` — dedup + limit semantics.
 *   - `getTurnSummary` / `getSessionSnapshot` — high-level wrappers.
 *   - `rejectPendingQuestions` — auto-respond loop with backend label.
 */

import { describe, it, expect, vi } from "vitest";

import {
  REMOTE_SESSION_MESSAGE_LIMIT,
  extractPartsSummary,
  extractAssistantUsage,
  summarizeAssistantMessages,
  listSessionMessages,
  getTurnSummary,
  getSessionSnapshot,
  rejectPendingQuestions,
  type RemoteSessionClient,
} from "../backend/remote-server/session-helpers.js";

function makeMockClient(
  overrides: {
    messages?: Array<unknown>;
    sessionGetTime?: { created?: number; updated?: number };
    questions?: Array<unknown>;
  } = {},
): {
  client: RemoteSessionClient;
  questionReplyCalls: Array<{ requestID: string; answers: unknown }>;
  questionRejectCalls: Array<{ requestID: string }>;
} {
  const questionReplyCalls: Array<{ requestID: string; answers: unknown }> = [];
  const questionRejectCalls: Array<{ requestID: string }> = [];
  const client: RemoteSessionClient = {
    mcp: { add: vi.fn(), disconnect: vi.fn() },
    session: {
      create: vi.fn(),
      get: vi.fn(async () => ({
        data: { time: overrides.sessionGetTime ?? {} },
      })),
      messages: vi.fn(async () => ({ data: overrides.messages ?? [] })),
    },
    tool: { ids: vi.fn() },
    provider: { list: vi.fn() },
    question: {
      list: vi.fn(async () => ({ data: overrides.questions ?? [] })),
      reply: vi.fn(async (args) => {
        questionReplyCalls.push(
          args as { requestID: string; answers: unknown },
        );
        return { ok: true };
      }),
      reject: vi.fn(async (args) => {
        questionRejectCalls.push(args as { requestID: string });
        return { ok: true };
      }),
    },
  };
  return { client, questionReplyCalls, questionRejectCalls };
}

// ── extractPartsSummary ────────────────────────────────────────────────────

describe("session-helpers / extractPartsSummary", () => {
  it("joins text parts with double-newline + counts tool parts", () => {
    const result = extractPartsSummary([
      { type: "text", text: "Hello" },
      { type: "text", text: "world" },
      { type: "tool", tool: "send" },
      { type: "tool", tool: "react" },
    ]);
    expect(result.text).toBe("Hello\n\nworld");
    expect(result.toolCalls).toBe(2);
    expect(result.syntheticErrorText).toBeUndefined();
  });

  it("peels synthetic text parts into syntheticErrorText", () => {
    const result = extractPartsSummary([
      { type: "text", text: "real reply" },
      {
        type: "text",
        text: "model hit output limit",
        synthetic: true,
      },
    ]);
    expect(result.text).toBe("real reply");
    expect(result.syntheticErrorText).toBe("model hit output limit");
  });

  it("returns syntheticErrorText alone when only synthetic parts present", () => {
    const result = extractPartsSummary([
      { type: "text", text: "boom", synthetic: true },
    ]);
    expect(result.text).toBe("");
    expect(result.syntheticErrorText).toBe("boom");
  });

  it("ignores reasoning + step parts", () => {
    const result = extractPartsSummary([
      { type: "reasoning", text: "private" },
      { type: "step-start" },
      { type: "step-finish" },
      { type: "text", text: "actual reply" },
    ]);
    expect(result.text).toBe("actual reply");
    expect(result.toolCalls).toBe(0);
  });

  it("returns empty for empty parts list", () => {
    expect(extractPartsSummary([])).toEqual({ text: "", toolCalls: 0 });
  });
});

// ── extractAssistantUsage ──────────────────────────────────────────────────

describe("session-helpers / extractAssistantUsage", () => {
  it("returns zeros for an undefined info blob", () => {
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

  it("extracts all token + cost fields when present", () => {
    expect(
      extractAssistantUsage({
        tokens: {
          input: 100,
          output: 50,
          cache: { read: 30, write: 10 },
        },
        cost: 0.05,
        providerID: "anthropic",
        modelID: "claude-opus-4-7",
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheRead: 30,
      cacheWrite: 10,
      costUsd: 0.05,
      providerID: "anthropic",
      modelID: "claude-opus-4-7",
    });
  });
});

// ── summarizeAssistantMessages ─────────────────────────────────────────────

describe("session-helpers / summarizeAssistantMessages", () => {
  it("aggregates tokens across multiple assistant messages", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          time: { created: 100, completed: 110 },
          tokens: { input: 10, output: 5, cache: { read: 1, write: 0 } },
          cost: 0.01,
        },
        parts: [{ type: "text", text: "a" }],
      },
      {
        info: {
          role: "assistant",
          time: { created: 200, completed: 210 },
          tokens: { input: 20, output: 10, cache: { read: 2, write: 1 } },
          cost: 0.02,
        },
        parts: [{ type: "text", text: "b" }],
      },
    ];

    const summary = summarizeAssistantMessages(messages);
    expect(summary.usage.assistantMessages).toBe(2);
    expect(summary.usage.inputTokens).toBe(30);
    expect(summary.usage.outputTokens).toBe(15);
    expect(summary.usage.cacheRead).toBe(3);
    expect(summary.usage.cacheWrite).toBe(1);
    expect(summary.usage.costUsd).toBeCloseTo(0.03);
    expect(summary.latestAssistant?.createdAt).toBe(200);
  });

  it("filters out messages older than minCreatedAt", () => {
    const messages = [
      {
        info: {
          role: "assistant",
          time: { created: 100, completed: 110 },
          tokens: { input: 10, output: 5 },
        },
        parts: [{ type: "text", text: "old" }],
      },
      {
        info: {
          role: "assistant",
          time: { created: 200, completed: 210 },
          tokens: { input: 20, output: 10 },
        },
        parts: [{ type: "text", text: "new" }],
      },
    ];

    const summary = summarizeAssistantMessages(
      messages,
      /* minCreatedAt */ 150,
    );
    expect(summary.usage.assistantMessages).toBe(1);
    expect(summary.usage.inputTokens).toBe(20);
  });

  it("skips non-assistant messages", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "u" }] },
      {
        info: {
          role: "assistant",
          time: { created: 100, completed: 110 },
          tokens: { input: 5, output: 3 },
        },
        parts: [{ type: "text", text: "a" }],
      },
    ];
    const summary = summarizeAssistantMessages(messages);
    expect(summary.usage.assistantMessages).toBe(1);
  });

  it("skips messages that are not meaningful (no parts + no usage + no completion)", () => {
    const messages = [
      // Empty assistant placeholder — skip
      {
        info: { role: "assistant", time: {} },
        parts: [],
      },
      // Real assistant message
      {
        info: {
          role: "assistant",
          time: { created: 100, completed: 110 },
          tokens: { input: 5, output: 3 },
        },
        parts: [{ type: "text", text: "a" }],
      },
    ];
    const summary = summarizeAssistantMessages(messages);
    expect(summary.usage.assistantMessages).toBe(1);
  });
});

// ── listSessionMessages ────────────────────────────────────────────────────

describe("session-helpers / listSessionMessages", () => {
  it("dedupes messages by info.id", async () => {
    const { client } = makeMockClient({
      messages: [
        { info: { id: "m1", role: "user" } },
        { info: { id: "m1", role: "user" } }, // duplicate
        { info: { id: "m2", role: "assistant" } },
      ],
    });
    const result = await listSessionMessages(client, "sess");
    expect(result).toHaveLength(2);
  });

  it("returns empty array when upstream returns no data", async () => {
    const { client } = makeMockClient({ messages: [] });
    const result = await listSessionMessages(client, "sess");
    expect(result).toEqual([]);
  });

  it("passes a default limit of REMOTE_SESSION_MESSAGE_LIMIT", async () => {
    const { client } = makeMockClient({ messages: [] });
    await listSessionMessages(client, "sess");
    expect(client.session.messages).toHaveBeenCalledWith({
      sessionID: "sess",
      limit: REMOTE_SESSION_MESSAGE_LIMIT,
    });
  });

  it("honors an explicit limit override", async () => {
    const { client } = makeMockClient({ messages: [] });
    await listSessionMessages(client, "sess", 42);
    expect(client.session.messages).toHaveBeenCalledWith({
      sessionID: "sess",
      limit: 42,
    });
  });
});

// ── getTurnSummary ─────────────────────────────────────────────────────────

describe("session-helpers / getTurnSummary", () => {
  it("aggregates messages with the supplied minCreatedAt", async () => {
    const { client } = makeMockClient({
      messages: [
        {
          info: {
            role: "assistant",
            id: "m1",
            time: { created: 50, completed: 55 },
            tokens: { input: 1, output: 1 },
          },
          parts: [{ type: "text", text: "old" }],
        },
        {
          info: {
            role: "assistant",
            id: "m2",
            time: { created: 200, completed: 205 },
            tokens: { input: 10, output: 5 },
          },
          parts: [{ type: "text", text: "new" }],
        },
      ],
    });
    const summary = await getTurnSummary(client, "sess", 100);
    expect(summary.usage.assistantMessages).toBe(1);
    expect(summary.usage.inputTokens).toBe(10);
  });
});

// ── getSessionSnapshot ─────────────────────────────────────────────────────

describe("session-helpers / getSessionSnapshot", () => {
  it("returns undefined when sessionId is empty", async () => {
    const { client } = makeMockClient();
    expect(await getSessionSnapshot(client, undefined)).toBeUndefined();
    expect(await getSessionSnapshot(client, "")).toBeUndefined();
  });

  it("builds a snapshot from session.get + session.messages", async () => {
    const { client } = makeMockClient({
      sessionGetTime: { created: 1000, updated: 2000 },
      messages: [
        {
          info: {
            role: "assistant",
            time: { created: 1500, completed: 1600 },
            tokens: {
              total: 99,
              input: 50,
              output: 30,
              reasoning: 10,
              cache: { read: 5, write: 2 },
            },
            cost: 0.005,
            providerID: "anthropic",
            modelID: "claude-opus-4-7",
          },
          parts: [{ type: "text", text: "x" }],
        },
      ],
    });

    const snapshot = await getSessionSnapshot(client, "sess");
    expect(snapshot).toBeDefined();
    expect(snapshot?.sessionId).toBe("sess");
    expect(snapshot?.createdAt).toBe(1000);
    expect(snapshot?.updatedAt).toBe(2000);
    expect(snapshot?.assistant?.providerID).toBe("anthropic");
    expect(snapshot?.assistant?.modelID).toBe("claude-opus-4-7");
    expect(snapshot?.assistant?.totalTokens).toBe(99);
    expect(snapshot?.assistant?.inputTokens).toBe(50);
    expect(snapshot?.assistant?.reasoningTokens).toBe(10);
    expect(snapshot?.usage?.assistantMessages).toBe(1);
    expect(snapshot?.usage?.totalCostUsd).toBeCloseTo(0.005);
  });

  it("returns snapshot with assistant: undefined when no assistant messages", async () => {
    const { client } = makeMockClient({
      sessionGetTime: { created: 100, updated: 200 },
      messages: [], // no messages
    });
    const snapshot = await getSessionSnapshot(client, "sess");
    expect(snapshot?.assistant).toBeUndefined();
    expect(snapshot?.usage?.assistantMessages).toBe(0);
  });
});

// ── rejectPendingQuestions ─────────────────────────────────────────────────

describe("session-helpers / rejectPendingQuestions", () => {
  it("auto-approves tool-approval questions with 'always'", async () => {
    const { client, questionReplyCalls } = makeMockClient({
      questions: [
        {
          id: "q1",
          sessionID: "sess",
          questions: [{ header: "Approve tool 'send'?" }],
        },
      ],
    });

    await rejectPendingQuestions(client, "sess", "chat-1", new Set(), "Kilo");

    expect(questionReplyCalls).toHaveLength(1);
    expect(questionReplyCalls[0].requestID).toBe("q1");
    expect(questionReplyCalls[0].answers).toEqual([["always"]]);
  });

  it("rejects non-tool questions", async () => {
    const { client, questionRejectCalls } = makeMockClient({
      questions: [
        {
          id: "q2",
          sessionID: "sess",
          questions: [{ header: "What is your favourite colour?" }],
        },
      ],
    });

    await rejectPendingQuestions(
      client,
      "sess",
      "chat-1",
      new Set(),
      "OpenCode",
    );

    expect(questionRejectCalls).toHaveLength(1);
    expect(questionRejectCalls[0].requestID).toBe("q2");
  });

  it("skips questions for other sessions", async () => {
    const { client, questionReplyCalls, questionRejectCalls } = makeMockClient({
      questions: [
        {
          id: "q3",
          sessionID: "other-sess",
          questions: [{ header: "Approve tool?" }],
        },
      ],
    });

    await rejectPendingQuestions(client, "sess", "chat-1", new Set(), "Kilo");

    expect(questionReplyCalls).toHaveLength(0);
    expect(questionRejectCalls).toHaveLength(0);
  });

  it("idempotent via seenQuestionIds — repeat call doesn't re-handle", async () => {
    const seen = new Set<string>();
    const { client, questionReplyCalls } = makeMockClient({
      questions: [
        {
          id: "q4",
          sessionID: "sess",
          questions: [{ header: "Approve tool?" }],
        },
      ],
    });

    await rejectPendingQuestions(client, "sess", "chat-1", seen, "Kilo");
    await rejectPendingQuestions(client, "sess", "chat-1", seen, "Kilo");
    await rejectPendingQuestions(client, "sess", "chat-1", seen, "Kilo");

    // Auto-approved exactly once
    expect(questionReplyCalls).toHaveLength(1);
  });

  it("does not throw if upstream reply/reject fails", async () => {
    const { client } = makeMockClient({
      questions: [
        {
          id: "q5",
          sessionID: "sess",
          questions: [{ header: "Approve?" }],
        },
      ],
    });
    client.question.reply = vi.fn(async () => {
      throw new Error("network");
    });

    await expect(
      rejectPendingQuestions(client, "sess", "chat-1", new Set(), "Kilo"),
    ).resolves.toBeUndefined();
  });
});
