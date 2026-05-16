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

// ── Coverage for the long tail of item types one-shot.ts handles ───────────

describe("codex / runOneShotAgent — extended item-type coverage", () => {
  /**
   * Drive runOneShotAgent against a custom event stream by re-mocking
   * the SDK for each test. Each test re-imports init + runOneShotAgent
   * after re-applying the mock to get a fresh Codex instance.
   */
  async function runWith(
    events: AsyncGenerator<Record<string, unknown>>,
  ): Promise<string[]> {
    vi.resetModules();
    vi.doMock("../core/plugin.js", () => ({
      getPluginMcpServers: vi.fn(() => ({})),
    }));
    vi.doMock("@openai/codex-sdk", () => {
      class MockThread {
        async runStreamed(_input: string, options?: { signal?: AbortSignal }) {
          void options;
          return { events };
        }
      }
      return {
        Codex: class {
          startThread() {
            return new MockThread();
          }
          resumeThread() {
            return new MockThread();
          }
        },
      };
    });

    const initMod = await import("../backend/codex/init.js");
    const runMod = await import("../backend/codex/one-shot.js");

    initMod.initCodexAgent(
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
    await runMod.runOneShotAgent({
      prompt: "Hello",
      systemPrompt: "You are an assistant.",
      workspace: "/tmp",
      model: "gpt-5-codex",
      contextLabel: "heartbeat",
      abortController: new AbortController(),
      appendLog: async (text: string) => {
        lines.push(text);
      },
    });
    return lines;
  }

  it("renders reasoning items as their own log section", async () => {
    const events = (async function* () {
      yield { type: "turn.started" };
      yield {
        type: "item.completed",
        item: { id: "i1", type: "reasoning", text: "deliberating quietly" },
      };
      yield { type: "turn.completed" };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Reasoning");
    expect(log).toContain("deliberating quietly");
  });

  it("renders command_execution items with status + exit code", async () => {
    const events = (async function* () {
      yield {
        type: "item.completed",
        item: {
          id: "i1",
          type: "command_execution",
          command: "ls -la",
          status: "completed",
          exit_code: 0,
        },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Command:");
    expect(log).toContain("ls -la");
    expect(log).toContain("completed");
    expect(log).toContain("exit=0");
  });

  it("renders file_change items with a per-file list", async () => {
    const events = (async function* () {
      yield {
        type: "item.completed",
        item: {
          id: "i1",
          type: "file_change",
          status: "completed",
          changes: [
            { kind: "create", path: "a.txt" },
            { kind: "edit", path: "b.txt" },
          ],
        },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("File changes:");
    expect(log).toContain("create a.txt");
    expect(log).toContain("edit b.txt");
  });

  it("renders web_search items with the query", async () => {
    const events = (async function* () {
      yield {
        type: "item.completed",
        item: {
          id: "i1",
          type: "web_search",
          query: "talon agent harness",
        },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Web search:");
    expect(log).toContain("talon agent harness");
  });

  it("renders todo_list items with checkbox state", async () => {
    const events = (async function* () {
      yield {
        type: "item.completed",
        item: {
          id: "i1",
          type: "todo_list",
          items: [
            { text: "first task", completed: true },
            { text: "second task", completed: false },
          ],
        },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Todo list:");
    expect(log).toContain("[x] first task");
    expect(log).toContain("[ ] second task");
  });

  it("surfaces turn.failed events with the upstream error message", async () => {
    const events = (async function* () {
      yield { type: "turn.started" };
      yield {
        type: "turn.failed",
        error: { message: "rate limit hit, try later" },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Turn FAILED");
    expect(log).toContain("rate limit hit, try later");
  });

  it("surfaces stream-level error events", async () => {
    const events = (async function* () {
      yield { type: "error", message: "connection reset" };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("ERROR");
    expect(log).toContain("connection reset");
  });

  it("renders unknown item types via the fallback JSON dump", async () => {
    const events = (async function* () {
      yield {
        type: "item.completed",
        item: {
          id: "i1",
          type: "future_capability",
          payload: { foo: "bar" },
        },
      };
    })();
    const log = (await runWith(events)).join("");
    expect(log).toContain("Item (future_capability)");
    expect(log).toContain("future_capability");
    expect(log).toContain("foo");
  });
});
