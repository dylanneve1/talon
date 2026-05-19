/**
 * Antigravity handler tests — mock the bridge to verify the
 * handler-level loop: prompt prep, stream-state accumulation,
 * terminator detection, delivery routing, usage propagation.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
} from "vitest";

vi.mock("../core/plugin.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
  getPluginPromptAdditions: vi.fn(() => ""),
  getPlugin: vi.fn(() => undefined),
}));

// Mock the bridge BEFORE importing the handler so init.ts's
// ensureBridge picks up our stub.
vi.mock("../backend/antigravity/init.js", () => {
  const ensureBridge = vi.fn();
  return {
    ensureBridge,
    initAntigravityAgent: vi.fn(),
  };
});

import { handleMessage } from "../backend/antigravity/handler.js";
import { ensureBridge } from "../backend/antigravity/init.js";
import { getState } from "../backend/antigravity/state.js";
import type {
  BridgeTurnResult,
  ChatOptions,
} from "../backend/antigravity/python-bridge.js";

// Helper — build a stub bridge that resolves chat() with the given result.
function stubBridge(scripted: {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  toolResults?: Array<{ name: string; result: unknown; error?: string | null }>;
  usage?: BridgeTurnResult["usage"];
  error?: Error;
}) {
  return {
    isReady: () => true,
    chat: vi.fn(async (opts: ChatOptions): Promise<BridgeTurnResult> => {
      // Mirror the bridge's onText / onToolCall delivery so the
      // handler accumulates state correctly.
      if (scripted.text && opts.onText) {
        opts.onText(scripted.text);
      }
      if (scripted.toolCalls && opts.onToolCall) {
        for (const tc of scripted.toolCalls) {
          opts.onToolCall(tc.name, tc.args);
        }
      }
      if (scripted.error) throw scripted.error;
      return {
        text: scripted.text ?? "",
        thoughts: "",
        toolCalls: (scripted.toolCalls ?? []).map((tc) => ({
          name: tc.name,
          args: tc.args,
        })),
        toolResults: (scripted.toolResults ?? []).map((tr) => ({
          name: tr.name,
          result: tr.result,
          error: tr.error ?? null,
        })),
        usage: scripted.usage ?? {
          prompt_token_count: 100,
          cached_content_token_count: 0,
          candidates_token_count: 20,
          thoughts_token_count: 0,
          total_token_count: 120,
        },
      };
    }),
    shutdown: vi.fn(),
    abort: vi.fn(),
  };
}

beforeAll(() => {
  // Pre-populate state.config so the handler doesn't bail with
  // "backend not initialized". Tests inject the bridge directly.
  const state = getState();
  state.config = {
    frontend: "telegram",
    backend: "antigravity",
    model: "gemini-3.5-flash",
    plugins: [],
  } as unknown as typeof state.config;
});

beforeEach(() => {
  vi.mocked(ensureBridge).mockReset();
});

afterEach(async () => {
  // Don't blow away state.config — only clear bridges.
  const state = getState();
  state.bridges.clear();
});

describe("antigravity handler — plain text turn", () => {
  it("delivers text via onTextBlock", async () => {
    const bridge = stubBridge({ text: "hello world" });
    vi.mocked(ensureBridge).mockResolvedValue(
      bridge as unknown as Awaited<ReturnType<typeof ensureBridge>>,
    );

    const onTextBlock = vi.fn(async (_text: string) => {});
    const result = await handleMessage({
      chatId: "test-chat-1",
      text: "say hi",
      senderName: "tester",
      onTextBlock,
    });

    expect(onTextBlock).toHaveBeenCalledOnce();
    expect(onTextBlock.mock.calls[0][0]).toBe("hello world");
    expect(result.text).toBe("hello world");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(20);
  });

  it("propagates streaming deltas via onStreamDelta", async () => {
    const bridge = stubBridge({ text: "delta-text" });
    vi.mocked(ensureBridge).mockResolvedValue(
      bridge as unknown as Awaited<ReturnType<typeof ensureBridge>>,
    );

    const deltas: Array<{ acc: string; phase?: string }> = [];
    await handleMessage({
      chatId: "test-chat-2",
      text: "stream test",
      senderName: "tester",
      onStreamDelta: (acc, phase) => {
        deltas.push({ acc, phase });
      },
      onTextBlock: vi.fn(async (_text: string) => {}),
    });

    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.at(-1)?.acc).toContain("delta-text");
    expect(deltas.at(-1)?.phase).toBe("text");
  });
});

describe("antigravity handler — tool calls", () => {
  it("calls onToolUse for each unique tool call", async () => {
    const bridge = stubBridge({
      text: "",
      toolCalls: [
        {
          name: "mcp__telegram-tools__send",
          args: { type: "text", text: "hi" },
        },
        {
          name: "mcp__telegram-tools__react",
          args: { emoji: "👍" },
        },
      ],
    });
    vi.mocked(ensureBridge).mockResolvedValue(
      bridge as unknown as Awaited<ReturnType<typeof ensureBridge>>,
    );

    const onToolUse = vi.fn();
    const onTextBlock = vi.fn(async (_text: string) => {});
    await handleMessage({
      chatId: "test-chat-3",
      text: "use tools",
      senderName: "tester",
      onToolUse,
      onTextBlock,
    });

    expect(onToolUse).toHaveBeenCalledTimes(2);
    // mcp__ prefix should be stripped before passing to onToolUse.
    expect(onToolUse.mock.calls[0][0]).toBe("send");
    expect(onToolUse.mock.calls[1][0]).toBe("react");
  });

  it("suppresses text delivery when end_turn fires (terminator route)", async () => {
    const bridge = stubBridge({
      text: "should not be delivered",
      toolCalls: [
        {
          name: "mcp__telegram-tools__end_turn",
          args: { text: "real reply" },
        },
      ],
    });
    vi.mocked(ensureBridge).mockResolvedValue(
      bridge as unknown as Awaited<ReturnType<typeof ensureBridge>>,
    );

    const onTextBlock = vi.fn(async (_text: string) => {});
    await handleMessage({
      chatId: "test-chat-4",
      text: "terminate",
      senderName: "tester",
      onTextBlock,
    });

    // The bridge delivered via end_turn (MCP); the text part should
    // NOT be re-delivered via onTextBlock.
    expect(onTextBlock).not.toHaveBeenCalled();
  });
});

describe("antigravity handler — error path", () => {
  it("rejects with a usable error when the bridge throws", async () => {
    const bridge = stubBridge({ error: new Error("bridge failure") });
    vi.mocked(ensureBridge).mockResolvedValue(
      bridge as unknown as Awaited<ReturnType<typeof ensureBridge>>,
    );

    const onTextBlock = vi.fn(async (_text: string) => {});
    await expect(
      handleMessage({
        chatId: "test-chat-5",
        text: "boom",
        senderName: "tester",
        onTextBlock,
      }),
    ).rejects.toThrow(/bridge failure/);
    // Handler surfaces the error to the user as well.
    expect(onTextBlock).toHaveBeenCalled();
    expect(onTextBlock.mock.calls[0][0]).toContain("bridge failure");
  });

  it("rejects + surfaces error when ensureBridge fails", async () => {
    vi.mocked(ensureBridge).mockRejectedValue(
      new Error("python venv not found"),
    );
    const onTextBlock = vi.fn(async (_text: string) => {});
    await expect(
      handleMessage({
        chatId: "test-chat-6",
        text: "start fail",
        senderName: "tester",
        onTextBlock,
      }),
    ).rejects.toThrow(/python venv/);
    expect(onTextBlock).toHaveBeenCalled();
    expect(onTextBlock.mock.calls[0][0]).toContain("python venv");
  });
});

describe("antigravity handler — usage propagation", () => {
  it("records cache reads in the returned result", async () => {
    const bridge = stubBridge({
      text: "cached",
      usage: {
        prompt_token_count: 50,
        cached_content_token_count: 40,
        candidates_token_count: 10,
        thoughts_token_count: 0,
        total_token_count: 100,
      },
    });
    vi.mocked(ensureBridge).mockResolvedValue(
      bridge as unknown as Awaited<ReturnType<typeof ensureBridge>>,
    );

    const onTextBlock = vi.fn(async (_text: string) => {});
    const result = await handleMessage({
      chatId: "test-chat-7",
      text: "cache",
      senderName: "tester",
      onTextBlock,
    });

    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(10);
    expect(result.cacheRead).toBe(40);
    expect(result.cacheWrite).toBe(0);
  });
});
