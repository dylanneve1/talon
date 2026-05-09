/**
 * Test helpers for driving the SDK against the stub claude binary.
 *
 * Typical usage in a test:
 *
 *   const result = await runWithStub({
 *     script: {
 *       turns: [{
 *         emit: [
 *           assistantText("hello"),
 *           assistantToolUse("mcp__telegram-tools__end_turn", { text: "hi" }),
 *           successResult(),
 *         ],
 *       }],
 *     },
 *     sdkOptions: { ...overrides },
 *     prompt: "user message",
 *   });
 *
 *   expect(result.messages.some(m => m.type === "assistant")).toBe(true);
 *   expect(result.hookFires.PostToolBatch).toBe(1);
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  HookCallback,
  HookEvent,
  HookCallbackMatcher,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  StubScript,
  StubAssistant,
  StubResult,
  StubFireHook,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
} from "./protocol.js";

// ── Fixture helpers ─────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// On Windows, Node 20.19+ refuses to spawn `.cmd` shims via child_process
// (CVE-2024-27980 mitigation). The SDK calls `spawn` directly without
// `shell: true`, so we use a SEA-compiled (.exe) binary instead. Build
// it once before the test run via `npm run build:stub-sea`.
const STUB_BINARY = resolve(
  __dirname,
  process.platform === "win32" ? "fake-claude.exe" : "fake-claude.mjs",
);

export function assistantText(text: string): StubAssistant {
  const block: TextBlock = { type: "text", text };
  return { type: "assistant", message: { content: [block] } };
}

export function assistantToolUse(
  name: string,
  input: Record<string, unknown>,
  id?: string,
): StubAssistant {
  const block: ToolUseBlock = {
    type: "tool_use",
    id: id ?? "toolu_" + randomUUID().slice(0, 8),
    name,
    input,
  };
  return {
    type: "assistant",
    message: { content: [block], stop_reason: "tool_use" },
  };
}

export function assistantBlocks(...blocks: ContentBlock[]): StubAssistant {
  return { type: "assistant", message: { content: blocks } };
}

export function successResult(text = ""): StubResult {
  return { type: "result", subtype: "success", result: text };
}

/**
 * Pseudo-emit that triggers a registered hook on the SDK side. The stub binary
 * sends a `control_request: hook_callback` to the SDK and waits for the
 * response. If the hook returns `continue: false`, the stub halts subsequent
 * emits in the same turn and emits a synthetic success result.
 *
 * Use this to verify hook wiring: the SDK only fires hooks if `options.hooks`
 * was correctly translated into the init handshake's `hookCallbackIds`.
 */
/**
 * Convenience: emit an assistant message that delivers `text` through the
 * canonical `end_turn` tool call, plus the matching PostToolBatch hook fire
 * (which is how the real production hook terminates the SDK loop).
 *
 * Mirrors the pattern Talon's system prompt teaches the model: final replies
 * go through `end_turn(text=...)`. Drop-in for tests that want to exercise
 * the production delivery path.
 */
export function endTurnWithText(
  text: string,
  toolUseId?: string,
): [StubAssistant, ReturnType<typeof fireHook>] {
  const id = toolUseId ?? "toolu_" + randomUUID().slice(0, 8);
  const assistant = assistantToolUse(
    "mcp__telegram-tools__end_turn",
    { text },
    id,
  );
  const hook = fireHook(
    "PostToolBatch",
    {
      tool_calls: [
        {
          tool_name: "mcp__telegram-tools__end_turn",
          tool_input: { text },
          tool_use_id: id,
        },
      ],
    },
    id,
  );
  return [assistant, hook];
}

export function fireHook(
  event:
    | "PreToolUse"
    | "PostToolUse"
    | "PostToolBatch"
    | "Stop"
    | "SessionStart"
    | "SessionEnd",
  input: Record<string, unknown>,
  toolUseId?: string,
): StubFireHook {
  return {
    type: "_fire_hook",
    event,
    input: { hook_event_name: event, ...input },
    tool_use_id: toolUseId,
  };
}

// ── Runner ──────────────────────────────────────────────────────────────────

export interface RunWithStubArgs {
  script: StubScript;
  prompt: string;
  /** Extra SDK options merged on top of the test defaults. */
  sdkOptions?: Partial<Options>;
  /** Hard timeout for the whole run (default 8s). */
  timeoutMs?: number;
}

export interface RunWithStubResult {
  /** Every message the SDK yielded, in order. */
  messages: unknown[];
  /** Per-event hook fire counts. Only set for hooks `runWithStub` injected. */
  hookFires: Partial<Record<HookEvent, number>>;
  /**
   * Per-event arrays of hook inputs (in order). Lets tests assert on what the
   * hook actually saw — e.g. which tool names were in the PostToolBatch.
   */
  hookInputs: Partial<Record<HookEvent, unknown[]>>;
  /** Lines captured from the binary's protocol log. */
  protocolLog: string[];
  /** The temp dir used (cleaned up on success). */
  tmpDir: string;
}

/**
 * Runs `query()` against the stub binary with the given script. Returns
 * everything the SDK yielded plus hook fire counts. Used by integration tests
 * to assert end-to-end behavior of options, hooks, and stream processing.
 */
export async function runWithStub(
  args: RunWithStubArgs,
): Promise<RunWithStubResult> {
  const { script, prompt, sdkOptions = {}, timeoutMs = 8000 } = args;

  const tmpDir = mkdtempSync(resolve(tmpdir(), "stub-claude-"));
  const scriptPath = resolve(tmpDir, "script.json");
  const logPath = resolve(tmpDir, "protocol.log");
  writeFileSync(scriptPath, JSON.stringify(script));

  // Spy hooks: wrap any hook the test passes so we can count fires.
  const hookFires: Partial<Record<HookEvent, number>> = {};
  const hookInputs: Partial<Record<HookEvent, unknown[]>> = {};
  const wrappedHooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

  if (sdkOptions.hooks) {
    for (const event of Object.keys(sdkOptions.hooks) as HookEvent[]) {
      const matchers = sdkOptions.hooks[event] ?? [];
      wrappedHooks[event] = matchers.map((matcher) => ({
        ...matcher,
        hooks: matcher.hooks.map<HookCallback>((fn) => async (...rest) => {
          hookFires[event] = (hookFires[event] ?? 0) + 1;
          (hookInputs[event] ??= []).push(rest[0]);
          return fn(...rest);
        }),
      }));
    }
  }

  // Wire the binary path + the env var carrying the script.
  process.env.STUB_CLAUDE_SCRIPT = scriptPath;
  process.env.STUB_CLAUDE_LOG = logPath;
  process.env.STUB_CLAUDE_TIMEOUT_MS = String(timeoutMs);

  const options: Options = {
    pathToClaudeCodeExecutable: STUB_BINARY,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...sdkOptions,
    hooks: wrappedHooks,
  };

  const messages: unknown[] = [];
  const abort = new AbortController();
  const hardTimer = setTimeout(() => abort.abort(), timeoutMs).unref();

  try {
    const it = query({
      prompt,
      options: { ...options, abortController: abort },
    });
    for await (const msg of it) {
      messages.push(msg);
    }
  } finally {
    clearTimeout(hardTimer);
    delete process.env.STUB_CLAUDE_SCRIPT;
    delete process.env.STUB_CLAUDE_LOG;
    delete process.env.STUB_CLAUDE_TIMEOUT_MS;
  }

  let protocolLog: string[] = [];
  try {
    const { readFileSync } = await import("node:fs");
    protocolLog = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  } catch {
    /* log file may not exist if binary failed to start */
  }

  return { messages, hookFires, hookInputs, protocolLog, tmpDir };
}

/**
 * Convenience: clean up the tmp dir created by `runWithStub`. Tests may want
 * to inspect it on failure, so cleanup is opt-in rather than automatic.
 */
export function cleanup(result: RunWithStubResult): void {
  rmSync(result.tmpDir, { recursive: true, force: true });
}
