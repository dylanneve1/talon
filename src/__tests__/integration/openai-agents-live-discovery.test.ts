/**
 * Live integration test for the `openai-agents` backend.
 *
 * Unlike kilo / opencode / claude / codex — which spawn a real
 * upstream CLI or HTTP daemon — the openai-agents backend talks
 * to any OpenAI-compatible HTTP endpoint over the wire. That makes
 * the natural live target a dummy OpenAI server we drive ourselves
 * (see `./dummy-openai-server.ts`), not a third-party CLI.
 *
 * The test boots Talon's actual openai-agents code path through the
 * production `handleMessage` entry — including model resolution,
 * `MemorySession` wiring, MCP server construction, agent run loop,
 * and delivery routing — pointed at the dummy server. The dummy
 * returns scripted SSE responses so we can assert deterministic
 * behaviour around:
 *
 *   1. Endpoint catalog enrichment via `GET /models`.
 *   2. Plain text replies via trailing prose delivery.
 *   3. Tool calls (model invokes a registered tool, sees the result,
 *      then produces the final reply).
 *   4. Multi-turn memory — the SDK's `MemorySession` should carry
 *      conversation state across `handleMessage` calls so the second
 *      turn sees the first turn's inputs and outputs.
 *   5. `resetChat()` clearing the session so the next turn starts
 *      fresh.
 *
 * The bot is bootstrapped with `frontend: "terminal"` so no Telegram
 * MCP servers spawn — keeps the test self-contained and fast.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { Gateway } from "../../core/engine/gateway.js";
import { resetSession } from "../../storage/sessions.js";
import type { TalonConfig } from "../../util/config.js";

import { initOpenAIAgentsAgent } from "../../backend/openai-agents/init.js";
import { fetchEndpointModels } from "../../backend/openai-agents/discovery.js";
import { handleMessage } from "../../backend/openai-agents/handler/index.js";
import {
  resetState,
  clearChatSession,
  getState,
} from "../../backend/openai-agents/state.js";
import { resolveModel } from "../../backend/openai-agents/models.js";

import {
  startDummyOpenAIServer,
  type DummyOpenAIServer,
} from "./dummy-openai-server.js";

let server: DummyOpenAIServer;

beforeAll(async () => {
  server = await startDummyOpenAIServer({
    models: [
      {
        id: "test/gpt-stub",
        name: "GPT Stub",
        context_length: 8192,
        pricing: { prompt: "0", completion: "0" },
      },
      {
        id: "test/gpt-stub-paid",
        name: "GPT Stub (paid)",
        context_length: 32_000,
        pricing: { prompt: "0.001", completion: "0.002" },
      },
    ],
  });
});

afterAll(async () => {
  await server?.close();
});

function bootBackend(extra: Partial<TalonConfig> = {}): Gateway {
  resetState();
  const gateway = new Gateway();
  const config: TalonConfig = {
    frontend: "terminal",
    backend: "openai-agents",
    model: "test/gpt-stub",
    openaiApiKey: "sk-test-fake",
    openaiBaseUrl: server.url,
    openaiApiMode: "chat_completions",
    workspace: "/tmp/talon-test",
    botToken: "",
    adminUserId: 0,
    maxMessageLength: 4000,
    concurrency: 1,
    pulse: false,
    pulseIntervalMs: 300000,
    ...extra,
  } as TalonConfig;
  initOpenAIAgentsAgent(config, () => gateway.getPort(), "terminal");
  return gateway;
}

beforeEach(() => {
  server.clearScript();
  // Reset Talon's session bookkeeping so each test starts at turn 0.
  resetSession("test-chat");
  clearChatSession("test-chat");
});

// ── 1. Endpoint catalog enrichment ─────────────────────────────────────────

describe("openai-agents live (dummy) / endpoint discovery", () => {
  it("populates the catalog from GET /models on init", async () => {
    bootBackend();
    // `fetchEndpointModels` is fire-and-forget in production; await it
    // directly so the test isn't racing the network call.
    await fetchEndpointModels(server.url, "sk-test-fake");

    const cat = getState().endpointModels;
    expect(cat.get("test/gpt-stub")?.contextWindow).toBe(8192);
    expect(cat.get("test/gpt-stub")?.free).toBe(true);
    expect(cat.get("test/gpt-stub-paid")?.contextWindow).toBe(32_000);
    expect(cat.get("test/gpt-stub-paid")?.free).toBeUndefined();
  });

  it("makes resolveModel return enriched info for advertised ids", async () => {
    bootBackend();
    await fetchEndpointModels(server.url, "sk-test-fake");
    const r = resolveModel("test/gpt-stub");
    expect(r.kind).toBe("exact");
    if (r.kind !== "exact") return;
    expect(r.model.contextWindow).toBe(8192);
    expect(r.model.free).toBe(true);
  });
});

// ── 2. Plain text turn ─────────────────────────────────────────────────────

describe("openai-agents live (dummy) / plain text turn", () => {
  it("captures the model's response text in the result but does NOT deliver it as a fallback", async () => {
    // Strict tool-only delivery: trailing prose is private scratchpad
    // and NEVER reaches the frontend. The model's text is still
    // recorded in `result.text` for tracing, but `onTextBlock` is
    // never called for trailing prose. To actually reach the user,
    // models must call a delivery tool (`end_turn` / `send` /
    // `react`); those aren't registered for `frontend: "terminal"`
    // (the test bootstrap), so this configuration is effectively
    // delivery-tool-less and the prose is silently dropped on
    // purpose.
    bootBackend();
    await fetchEndpointModels(server.url, "sk-test-fake");
    server.setScript([{ text: "Hello back!", finishReason: "stop" }]);

    const blocks: string[] = [];
    const result = await handleMessage({
      chatId: "test-chat",
      text: "Hi there",
      senderName: "Tester",
      isGroup: false,
      messageId: 1,
      onTextBlock: async (b: string) => {
        blocks.push(b);
      },
    });

    expect(result.text).toContain("Hello back");
    expect(blocks).toEqual([]);

    const reqs = server
      .getRequests()
      .filter((r) => r.path.endsWith("/chat/completions"));
    expect(reqs).toHaveLength(1);
    const body = reqs[0].body as { messages: Array<{ role: string }> };
    expect(body.messages.some((m) => m.role === "user")).toBe(true);
  });
});

// ── 3. Tool call dispatch ──────────────────────────────────────────────────

describe("openai-agents live (dummy) / tool call dispatch", () => {
  it("invokes a builtin tool when the model asks for it, then resolves with the final reply", async () => {
    bootBackend();
    await fetchEndpointModels(server.url, "sk-test-fake");

    // Two requests: the first one returns a Bash tool call (which the
    // backend executes locally via the openai-agents builtin), the
    // second returns the final assistant text containing the tool's
    // output.
    server.setScript([
      {
        toolCalls: [
          {
            name: "Bash",
            arguments: {
              command: "echo dummy-tool-output",
              description: null,
              timeout_ms: null,
            },
          },
        ],
        finishReason: "tool_calls",
      },
      {
        text: "Tool returned: dummy-tool-output",
        finishReason: "stop",
      },
    ]);

    const tools: string[] = [];
    const result = await handleMessage({
      chatId: "test-chat",
      text: "run that command",
      senderName: "Tester",
      isGroup: false,
      messageId: 2,
      onToolUse: (name) => tools.push(name),
    });

    expect(tools).toContain("Bash");
    expect(result.text).toContain("dummy-tool-output");

    const reqs = server
      .getRequests()
      .filter((r) => r.path.endsWith("/chat/completions"));
    // At least two round-trips: initial tool request + follow-up
    // with the tool result. The SDK may emit additional helper
    // round-trips depending on the model's run policy; we only
    // care that *some* follow-up carries the tool result.
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    const allMessages = reqs.flatMap(
      (r) =>
        (
          r.body as {
            messages: Array<{
              role: string;
              tool_call_id?: string;
              content?: string;
            }>;
          }
        ).messages,
    );
    const toolMsg = allMessages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content ?? "").toContain("dummy-tool-output");
  }, 15_000);
});

// ── 4. Multi-turn memory via MemorySession ─────────────────────────────────

describe("openai-agents live (dummy) / multi-turn memory", () => {
  it("carries prior turn into the second turn's request payload", async () => {
    bootBackend();
    await fetchEndpointModels(server.url, "sk-test-fake");

    server.setScript([
      { text: "First reply", finishReason: "stop" },
      { text: "Second reply", finishReason: "stop" },
    ]);

    await handleMessage({
      chatId: "test-chat",
      text: "first prompt",
      senderName: "Tester",
      isGroup: false,
      messageId: 10,
    });
    server.clearRequests();

    await handleMessage({
      chatId: "test-chat",
      text: "second prompt",
      senderName: "Tester",
      isGroup: false,
      messageId: 11,
    });

    const reqs = server
      .getRequests()
      .filter((r) => r.path.endsWith("/chat/completions"));
    expect(reqs).toHaveLength(1);
    const body = reqs[1] ?? reqs[0];
    const messages = (
      body.body as { messages: Array<{ role: string; content?: unknown }> }
    ).messages;

    // Turn 2's request should include turn 1's user prompt + assistant
    // reply in its messages array — that's how MemorySession threads
    // history into subsequent run() calls.
    const userTexts = messages
      .filter((m) => m.role === "user")
      .map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      );
    const assistantTexts = messages
      .filter((m) => m.role === "assistant")
      .map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      );

    expect(userTexts.some((t) => t.includes("first prompt"))).toBe(true);
    expect(assistantTexts.some((t) => t.includes("First reply"))).toBe(true);
    expect(userTexts.some((t) => t.includes("second prompt"))).toBe(true);
  });

  it("does not leak memory across chats", async () => {
    bootBackend();
    await fetchEndpointModels(server.url, "sk-test-fake");

    server.setScript([
      { text: "Reply to chat A", finishReason: "stop" },
      { text: "Reply to chat B", finishReason: "stop" },
    ]);

    await handleMessage({
      chatId: "chat-A",
      text: "Hi from A",
      senderName: "Tester",
      isGroup: false,
      messageId: 1,
    });
    server.clearRequests();

    await handleMessage({
      chatId: "chat-B",
      text: "Hi from B",
      senderName: "Tester",
      isGroup: false,
      messageId: 2,
    });

    const reqs = server
      .getRequests()
      .filter((r) => r.path.endsWith("/chat/completions"));
    const lastBody = reqs[reqs.length - 1].body as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    const userTexts = lastBody.messages
      .filter((m) => m.role === "user")
      .map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      );
    // Chat B's request must NOT contain chat A's prompt.
    expect(userTexts.some((t) => t.includes("Hi from B"))).toBe(true);
    expect(userTexts.some((t) => t.includes("Hi from A"))).toBe(false);
  });
});

// ── 5. resetChat clears the session ────────────────────────────────────────

describe("openai-agents live (dummy) / resetChat", () => {
  it("wipes the MemorySession so the next turn starts blank", async () => {
    bootBackend();
    await fetchEndpointModels(server.url, "sk-test-fake");

    server.setScript([
      { text: "Reply 1", finishReason: "stop" },
      { text: "Reply 2", finishReason: "stop" },
    ]);

    await handleMessage({
      chatId: "test-chat",
      text: "remember me",
      senderName: "Tester",
      isGroup: false,
      messageId: 1,
    });

    // Manually invoke the backend's resetChat (the same call /reset
    // makes in production).
    clearChatSession("test-chat");
    server.clearRequests();

    await handleMessage({
      chatId: "test-chat",
      text: "fresh start",
      senderName: "Tester",
      isGroup: false,
      messageId: 2,
    });

    const reqs = server
      .getRequests()
      .filter((r) => r.path.endsWith("/chat/completions"));
    expect(reqs).toHaveLength(1);
    const messages = (
      reqs[0].body as { messages: Array<{ role: string; content?: unknown }> }
    ).messages;
    const allText = messages
      .map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      )
      .join("\n");
    expect(allText).not.toContain("remember me");
    expect(allText).toContain("fresh start");
  });
});
