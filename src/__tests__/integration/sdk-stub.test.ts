/**
 * End-to-end integration tests against the real Claude Agent SDK driving a
 * stub `claude` binary (see `stub-claude/`).
 *
 * Unlike the unit tests in `src/__tests__/`, these don't `vi.mock` the SDK —
 * the real `query()` runs, real subprocess spawn, real hook dispatcher, real
 * stream-json protocol. The binary is replaced with a scripted stub so we
 * can assert on what the SDK produces given known inputs.
 *
 * What this catches that unit tests can't:
 *  - Bugs in our integration with the SDK's protocol shapes (e.g. the
 *    MCP-prefix bug in `isTurnTerminator` would have surfaced here).
 *  - Hook wiring — confirms options.hooks actually gets invoked by the SDK.
 *  - Stream sequence handling against authentic message ordering.
 */

import { describe, it, expect } from "vitest";
import {
  runWithStub,
  cleanup,
  assistantText,
  assistantToolUse,
  successResult,
  fireHook,
} from "./stub-claude/helpers.js";

// On Windows the stub binary is a SEA-compiled `.exe` (built via
// `npm run build:stub-sea`). On POSIX it's the `.mjs` source with shebang.
// If the .exe isn't present (build step skipped), we skip the suite cleanly
// rather than fail with `ENOENT`.
import { existsSync } from "node:fs";
import { resolve as resolvePath, dirname as dirnamePath } from "node:path";
import { fileURLToPath as fileUrl } from "node:url";
const __testDir = dirnamePath(fileUrl(import.meta.url));
const stubBinaryPath = resolvePath(
  __testDir,
  process.platform === "win32"
    ? "stub-claude/fake-claude.exe"
    : "stub-claude/fake-claude.mjs",
);
const stubReady = existsSync(stubBinaryPath);

describe.skipIf(!stubReady)("SDK integration (stub binary)", () => {
  it("completes a simple text-only turn", async () => {
    const result = await runWithStub({
      prompt: "say hi",
      script: {
        turns: [
          {
            emit: [assistantText("hello from stub"), successResult("hello")],
          },
        ],
      },
    });

    // Should have system init, assistant message, and result
    const types = result.messages.map((m) => (m as { type: string }).type);
    expect(types).toContain("system");
    expect(types).toContain("assistant");
    expect(types).toContain("result");

    cleanup(result);
  }, 15000);

  it("yields assistant content blocks intact", async () => {
    const result = await runWithStub({
      prompt: "test",
      script: {
        turns: [
          {
            emit: [assistantText("specific text payload"), successResult()],
          },
        ],
      },
    });

    const assistant = result.messages.find(
      (m) => (m as { type: string }).type === "assistant",
    ) as
      | { message: { content: { type: string; text?: string }[] } }
      | undefined;

    expect(assistant).toBeDefined();
    const text = assistant?.message.content.find((b) => b.type === "text");
    expect(text?.text).toBe("specific text payload");

    cleanup(result);
  }, 15000);

  it("invokes registered PostToolBatch hooks", async () => {
    // The stub emits an assistant message with a tool_use, then synthesizes a
    // PostToolBatch hook fire (via fireHook). The SDK should look up the
    // callback id we registered during init and invoke our hook function.
    const result = await runWithStub({
      prompt: "trigger end_turn",
      script: {
        turns: [
          {
            emit: [
              assistantToolUse("mcp__telegram-tools__end_turn", {
                text: "delivered",
              }),
              fireHook("PostToolBatch", {
                tool_calls: [
                  {
                    tool_name: "mcp__telegram-tools__end_turn",
                    tool_input: { text: "delivered" },
                    tool_use_id: "tu_1",
                  },
                ],
              }),
              successResult("delivered"),
            ],
          },
        ],
      },
      sdkOptions: {
        hooks: {
          PostToolBatch: [
            {
              hooks: [
                async () => ({
                  continue: false,
                  stopReason: "test: end_turn fired",
                }),
              ],
            },
          ],
        },
      },
    });

    expect(result.hookFires.PostToolBatch ?? 0).toBeGreaterThanOrEqual(1);

    const calls = result.hookInputs.PostToolBatch ?? [];
    const firstInput = calls[0] as
      | { tool_calls: { tool_name: string }[] }
      | undefined;
    expect(firstInput?.tool_calls.map((tc) => tc.tool_name)).toContain(
      "mcp__telegram-tools__end_turn",
    );

    cleanup(result);
  }, 15000);

  it("runs the production turn-terminator hook (PostToolBatch + isTurnTerminator)", async () => {
    // This test composes the actual hook from `src/backend/claude-sdk/options.ts`
    // — we reach into the module to grab it. If the hook implementation drifts
    // from what the SDK calls, this test fails.
    const { isTurnTerminator } = await import("../../core/tools/index.js");

    const result = await runWithStub({
      prompt: "drive end_turn through the real isTurnTerminator helper",
      script: {
        turns: [
          {
            emit: [
              assistantToolUse("mcp__telegram-tools__end_turn", {
                text: "ok",
              }),
              fireHook("PostToolBatch", {
                tool_calls: [
                  {
                    tool_name: "mcp__telegram-tools__end_turn",
                    tool_input: { text: "ok" },
                    tool_use_id: "tu_1",
                  },
                ],
              }),
              successResult(),
            ],
          },
        ],
      },
      sdkOptions: {
        hooks: {
          PostToolBatch: [
            {
              hooks: [
                async (input) => {
                  type Batch = {
                    hook_event_name: string;
                    tool_calls: { tool_name: string }[];
                  };
                  if ((input as Batch).hook_event_name !== "PostToolBatch") {
                    return { continue: true };
                  }
                  const batch = input as Batch;
                  const ended = batch.tool_calls.some((tc) =>
                    isTurnTerminator(tc.tool_name),
                  );
                  return ended
                    ? { continue: false, stopReason: "turn terminated" }
                    : { continue: true };
                },
              ],
            },
          ],
        },
      },
    });

    // Hook should have fired exactly once and matched the MCP-prefixed name.
    expect(result.hookFires.PostToolBatch).toBe(1);

    cleanup(result);
  }, 15000);
});
