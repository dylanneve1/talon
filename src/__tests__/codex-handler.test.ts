/**
 * Codex handler integration tests — exercise the main handleMessage
 * flow with a sophisticated `@openai/codex-sdk` mock.
 *
 * The handler's responsibility is to:
 *   1. Build the prompt + system prefix (first-turn only).
 *   2. Start or resume a Codex thread.
 *   3. Drive `runStreamed` and translate events into stream state.
 *   4. Abort the thread when a terminator tool fires.
 *   5. Route delivery (text-part / synthetic-error / empty / tool) via shared.
 *   6. Persist the thread id for future resume.
 *
 * These tests verify each path with hand-built event sequences.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Shared mock state ───────────────────────────────────────────────────────

interface MockEvent {
  type: string;
  [key: string]: unknown;
}

let MOCK_EVENTS: MockEvent[] = [];
let MOCK_RUN_STREAMED_CALLS: Array<{ input: string; signal?: AbortSignal }> =
  [];
let MOCK_THREAD_OPTIONS_SEEN: Array<Record<string, unknown>> = [];
let MOCK_RESUME_CALLS: string[] = [];
let MOCK_RUN_STREAMED_THROWS: Error | null = null;

vi.mock("@openai/codex-sdk", () => {
  class MockThread {
    constructor(public id: string | null = null) {}
    async runStreamed(input: string, options?: { signal?: AbortSignal }) {
      MOCK_RUN_STREAMED_CALLS.push({ input, signal: options?.signal });
      if (MOCK_RUN_STREAMED_THROWS) {
        throw MOCK_RUN_STREAMED_THROWS;
      }
      const events = (async function* (): AsyncGenerator<MockEvent> {
        for (const event of MOCK_EVENTS) {
          yield event;
        }
      })();
      return { events };
    }
  }
  return {
    Codex: class {
      constructor(public options: unknown) {}
      startThread(options?: Record<string, unknown>) {
        MOCK_THREAD_OPTIONS_SEEN.push(options ?? {});
        return new MockThread();
      }
      resumeThread(id: string, options?: Record<string, unknown>) {
        MOCK_RESUME_CALLS.push(id);
        MOCK_THREAD_OPTIONS_SEEN.push(options ?? {});
        return new MockThread(id);
      }
    },
  };
});

vi.mock("../core/plugin.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
  getPluginPromptAdditions: vi.fn(() => []),
}));

vi.mock("../util/trace.js", () => ({
  traceMessage: vi.fn(),
}));

// Modules under test (imported after mocks are wired)
const { handleMessage } = await import("../backend/codex/handler.js");
const { initCodexAgent } = await import("../backend/codex/init.js");
const { resetState } = await import("../backend/codex/state.js");
const sessions = await import("../storage/sessions.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function setupHandler(): void {
  initCodexAgent(
    {
      model: "gpt-5-codex",
      workspace: "/tmp",
      systemPrompt: "Test system prompt.",
      frontend: "telegram",
    } as never,
    () => 19876,
    "telegram",
  );
}

function resetMocks(): void {
  MOCK_EVENTS = [];
  MOCK_RUN_STREAMED_CALLS = [];
  MOCK_THREAD_OPTIONS_SEEN = [];
  MOCK_RESUME_CALLS = [];
  MOCK_RUN_STREAMED_THROWS = null;
}

beforeEach(() => {
  resetState();
  resetMocks();
  // Clear any stored session state from previous tests.
  sessions.resetSession("test-chat");
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("codex / handleMessage — happy path", () => {
  it("starts a fresh thread on first turn + ships the agent message", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_test_1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "i1",
          type: "agent_message",
          text: "Hello from Codex.",
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cached_input_tokens: 10,
          reasoning_output_tokens: 5,
        },
      },
    ];

    const delivered: string[] = [];
    const result = await handleMessage({
      chatId: "test-chat",
      text: "Say hi",
      senderName: "Dylan",
      isGroup: false,
      onTextBlock: async (text) => {
        delivered.push(text);
      },
    });

    expect(result.text).toBe("Hello from Codex.");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.cacheRead).toBe(10);
    expect(delivered).toEqual(["Hello from Codex."]);
    // Thread started fresh, not resumed
    expect(MOCK_RESUME_CALLS).toEqual([]);
    expect(MOCK_RUN_STREAMED_CALLS).toHaveLength(1);
    // Thread id persisted in session storage
    expect(sessions.getSession("test-chat").sessionId).toBe("thr_test_1");
  });

  it("resumes existing thread on second turn", async () => {
    setupHandler();
    sessions.setSessionId("test-chat", "thr_resumed_42");

    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_resumed_42" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "Continuing." },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          cached_input_tokens: 5,
          reasoning_output_tokens: 0,
        },
      },
    ];

    // Mark previous turns so the system prompt isn't re-prepended.
    sessions.incrementTurns("test-chat");

    await handleMessage({
      chatId: "test-chat",
      text: "What did I say before?",
      senderName: "Dylan",
      isGroup: false,
    });

    expect(MOCK_RESUME_CALLS).toEqual(["thr_resumed_42"]);
    // On resumed turn, the prompt does NOT carry the system-prefix preamble
    const sentInput = MOCK_RUN_STREAMED_CALLS[0].input;
    expect(sentInput).not.toMatch(/^Test system prompt/);
  });

  it("prepends system prompt on first turn", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_x" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "ok" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "First message",
      senderName: "Dylan",
      isGroup: false,
    });

    const sentInput = MOCK_RUN_STREAMED_CALLS[0].input;
    // System prompt is prepended (with Codex suffix added by prepareSystemPrompt)
    expect(sentInput).toMatch(/Codex Delivery/);
    expect(sentInput).toContain("First message");
  });
});

describe("codex / handleMessage — error paths", () => {
  it("turn.failed event surfaces as syntheticError → delivery emits ⚠️", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_fail" },
      { type: "turn.started" },
      {
        type: "turn.failed",
        error: { message: "model overloaded" },
      },
    ];

    const delivered: string[] = [];
    const result = await handleMessage({
      chatId: "test-chat",
      text: "boom",
      senderName: "Dylan",
      isGroup: false,
      onTextBlock: async (t) => {
        delivered.push(t);
      },
    });

    expect(delivered[0]).toBe("⚠️ Codex: model overloaded");
    // `result.text` is empty for the synthetic-error route
    expect(result.text).toBe("");
  });

  it("error event also surfaces as synthetic", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_err" },
      { type: "error", message: "fatal stream error" },
    ];

    const delivered: string[] = [];
    await handleMessage({
      chatId: "test-chat",
      text: "boom",
      senderName: "Dylan",
      isGroup: false,
      onTextBlock: async (t) => {
        delivered.push(t);
      },
    });

    expect(delivered[0]).toBe("⚠️ Codex: fatal stream error");
  });

  it("empty turn (no agent_message, no failure) emits empty-turn notice", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_empty" },
      { type: "turn.started" },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cached_input_tokens: 0,
          reasoning_output_tokens: 5,
        },
      },
    ];

    const delivered: string[] = [];
    await handleMessage({
      chatId: "test-chat",
      text: "say nothing",
      senderName: "Dylan",
      isGroup: false,
      onTextBlock: async (t) => {
        delivered.push(t);
      },
    });

    expect(delivered[0]).toContain("no reply");
  });
});

describe("codex / handleMessage — tool use", () => {
  it("mcp_tool_call items get recorded as toolCalls + onToolUse fires", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_tool" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "i1",
          type: "mcp_tool_call",
          server: "telegram-tools",
          tool: "react",
          arguments: { emoji: "🔥" },
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { id: "i2", type: "agent_message", text: "reacted" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    const tools: Array<{ name: string; input: Record<string, unknown> }> = [];
    await handleMessage({
      chatId: "test-chat",
      text: "react with fire",
      senderName: "Dylan",
      isGroup: false,
      onToolUse: (name, input) => {
        tools.push({ name, input });
      },
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("react");
    expect(tools[0].input).toEqual({ emoji: "🔥" });
  });

  it("end_turn-as-MCP-tool triggers abort", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_end_turn" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "i1",
          type: "mcp_tool_call",
          server: "telegram-tools",
          tool: "end_turn",
          arguments: { text: "done!" },
          status: "completed",
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cached_input_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
    ];

    await handleMessage({
      chatId: "test-chat",
      text: "wrap up",
      senderName: "Dylan",
      isGroup: false,
    });

    // The signal should have been aborted by the terminator path
    expect(MOCK_RUN_STREAMED_CALLS[0].signal?.aborted).toBe(true);
  });
});

describe("codex / handleMessage — usage propagation", () => {
  it("propagates Codex usage into the QueryResult", async () => {
    setupHandler();
    MOCK_EVENTS = [
      { type: "thread.started", thread_id: "thr_usage" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "answer" },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1234,
          output_tokens: 567,
          cached_input_tokens: 89,
          reasoning_output_tokens: 12,
        },
      },
    ];

    const result = await handleMessage({
      chatId: "test-chat",
      text: "q",
      senderName: "Dylan",
      isGroup: false,
    });

    expect(result.inputTokens).toBe(1234);
    expect(result.outputTokens).toBe(567);
    expect(result.cacheRead).toBe(89);
    // Codex doesn't surface cache writes
    expect(result.cacheWrite).toBe(0);
  });
});
