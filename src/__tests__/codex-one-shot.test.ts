/**
 * Codex one-shot agent runner tests.
 *
 * Exercises the event-translation layer that turns Codex's
 * `runStreamed` `ThreadEvent` stream into run-log lines used by
 * heartbeat + dream. The full path (spawning `codex` CLI) isn't
 * exercisable without the binary on PATH, but the per-event/per-item
 * formatting logic is pure and we can hand-build representative
 * events.
 *
 * We don't import `runOneShotAgent` directly because it depends on
 * `ensureCodex` which spawns the CLI. Instead this file imports the
 * source for the test surface area via a thin helper export.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../core/plugin.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
}));

vi.mock("@openai/codex-sdk", () => {
  // Light mock — `runOneShotAgent` only needs `startThread` and a
  // working `runStreamed` AsyncGenerator.
  class MockThread {
    async runStreamed(_input: string, options?: { signal?: AbortSignal }) {
      const events = (async function* () {
        yield { type: "thread.started", thread_id: "thr_test" };
        yield { type: "turn.started" };
        yield {
          type: "item.completed",
          item: {
            id: "i1",
            type: "agent_message",
            text: "Hello from Codex.",
          },
        };
        yield {
          type: "item.completed",
          item: {
            id: "i2",
            type: "mcp_tool_call",
            server: "telegram-tools",
            tool: "send",
            arguments: { type: "text", text: "ok" },
            status: "completed",
          },
        };
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cached_input_tokens: 10,
            reasoning_output_tokens: 5,
          },
        };
      })();
      void options;
      return { events };
    }
  }
  return {
    Codex: class {
      // The init module accesses `__talonChatId` as a stash slot.
      // Allow arbitrary property writes via `as any` in init.ts.
      startThread() {
        return new MockThread();
      }
      resumeThread() {
        return new MockThread();
      }
    },
  };
});

// Now import after the mocks are wired
const { runOneShotAgent } = await import("../backend/codex/one-shot.js");
const { initCodexAgent } = await import("../backend/codex/init.js");

describe("codex / runOneShotAgent — event → log translation", () => {
  it("appends thread-started, turn lifecycle, agent message, and tool call", async () => {
    initCodexAgent(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "terminal",
        openaiApiKey: "test-key",
      } as never,
      () => 19876,
      "terminal",
    );

    const lines: string[] = [];
    const appendLog = async (text: string) => {
      lines.push(text);
    };
    const abortController = new AbortController();

    await runOneShotAgent({
      prompt: "Hello",
      systemPrompt: "You are an assistant.",
      workspace: "/tmp",
      model: "gpt-5-codex",
      contextLabel: "heartbeat",
      abortController,
      appendLog,
    });

    const log = lines.join("");
    expect(log).toContain("Thread started");
    expect(log).toContain("thr_test");
    expect(log).toContain("Turn started");
    expect(log).toContain("Turn completed");
    expect(log).toContain("input=100");
    expect(log).toContain("output=50");
    expect(log).toContain("Assistant");
    expect(log).toContain("Hello from Codex.");
    expect(log).toContain("MCP tool call");
    expect(log).toContain("telegram-tools.send");
  });

  it("stops appending once the abort signal fires", async () => {
    initCodexAgent(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "terminal",
        openaiApiKey: "test-key",
      } as never,
      () => 19876,
      "terminal",
    );

    const lines: string[] = [];
    const appendLog = async (text: string) => {
      lines.push(text);
    };
    const abortController = new AbortController();
    // Fire abort immediately
    abortController.abort();

    await runOneShotAgent({
      prompt: "Hello",
      systemPrompt: "You are an assistant.",
      workspace: "/tmp",
      model: "gpt-5-codex",
      contextLabel: "heartbeat",
      abortController,
      appendLog,
    });

    const log = lines.join("");
    expect(log).toContain("Aborted");
  });
});
