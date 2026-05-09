/**
 * Functional tests: drives Talon's `handleMessage` end-to-end against the stub
 * binary. Tests cover real conversational structures — single-turn replies,
 * tool-call dispatch, multi-turn dialogue, error paths.
 *
 * Unlike `sdk-stub.test.ts` which pokes `query()` directly with a custom hook,
 * these tests run the full Talon code path: prompt building, system-prompt
 * rebuild, options builder (including the production PostToolBatch hook),
 * stream processing, session bookkeeping. The stub binary plays the role of
 * the live API.
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  runTalonTurn,
  cleanupTurn,
  teardownBootstrap,
} from "./talon-bootstrap.js";
import {
  assistantText,
  endTurnWithText,
  successResult,
} from "./stub-claude/helpers.js";

/** Pull delivered text from end_turn tool calls — same path the bridge uses. */
function deliveredText(
  toolUses: { name: string; input: Record<string, unknown> }[],
): string {
  return toolUses
    .filter((t) => t.name.endsWith("end_turn") || t.name === "end_turn")
    .map((t) => (typeof t.input.text === "string" ? t.input.text : ""))
    .join("");
}

// Skip if the stub binary isn't on disk (e.g. someone forgot to run
// `npm run build:stub-sea` on Windows). On POSIX the .mjs source is always
// shipped so this is effectively always true.
import { existsSync } from "node:fs";
import { resolve as resolvePath, dirname as dirnamePath } from "node:path";
import { fileURLToPath as fileUrl } from "node:url";
const __testDir = dirnamePath(fileUrl(import.meta.url));
const stubReady = existsSync(
  resolvePath(
    __testDir,
    process.platform === "win32"
      ? "stub-claude/fake-claude.exe"
      : "stub-claude/fake-claude.mjs",
  ),
);

describe.skipIf(!stubReady)("Talon functional — single-turn", () => {
  afterAll(() => {
    teardownBootstrap();
  });

  it("delivers a final reply via end_turn and triggers PostToolBatch", async () => {
    const [assistant, hook] = endTurnWithText("hello back");
    const result = await runTalonTurn({
      prompt: "say hello",
      script: {
        turns: [
          {
            emit: [assistant, hook, successResult("hello back")],
          },
        ],
      },
      resetSession: true,
    });

    // The stub delivered via end_turn. The handler should have captured the
    // tool call (which is how the bridge would deliver to the user).
    expect(deliveredText(result.toolUses)).toBe("hello back");
    // No plain text blocks should leak — production contract is "no scratchpad".
    expect(result.text).toBe("");
    expect(result.protocolLog.length).toBeGreaterThan(0);
    cleanupTurn(result);
  }, 20000);

  it("treats raw assistant text without end_turn as scratchpad (dropped)", async () => {
    // This documents the production contract: text not routed through end_turn
    // is private scratchpad. The flow-violation retry path would fire too in
    // production; we don't assert on the retry here, only on first-turn drop.
    const result = await runTalonTurn({
      prompt: "send raw text",
      script: {
        turns: [
          {
            emit: [assistantText("this should be dropped"), successResult()],
          },
          // Second turn handles the scratchpad-violation re-prompt that fires:
          // we just emit a clean end_turn() to close.
          {
            emit: [...endTurnWithText(""), successResult()],
          },
        ],
      },
      resetSession: true,
    });

    // The raw text never reaches onTextBlock — it's private scratchpad.
    expect(result.text).toBe("");
    cleanupTurn(result);
  }, 25000);

  it("emits progress text before tool calls via onTextBlock", async () => {
    // Real production pattern: model writes a brief "thinking out loud" text
    // chunk before calling a tool. That text flows through `progressTexts`
    // → `onTextBlock`, separate from the trailing/scratchpad path.
    const [endTurn, hook] = endTurnWithText("done");
    const result = await runTalonTurn({
      prompt: "step then deliver",
      script: {
        turns: [
          {
            emit: [
              {
                type: "assistant",
                message: {
                  stop_reason: "tool_use",
                  content: [
                    { type: "text", text: "Working on it... " },
                    {
                      type: "tool_use",
                      id: "tu_progress",
                      name: "mcp__telegram-tools__end_turn",
                      input: { text: "done" },
                    },
                  ],
                },
              },
              hook,
              successResult("done"),
            ],
          },
        ],
      },
      resetSession: true,
    });

    expect(result.text).toContain("Working on it");
    expect(deliveredText(result.toolUses)).toBe("done");
    // We crafted the assistant message manually instead of using the helper.
    void endTurn;
    cleanupTurn(result);
  }, 20000);

  it("records token usage from the stub's result message", async () => {
    const [assistant, hook] = endTurnWithText("ok");
    const result = await runTalonTurn({
      prompt: "test usage",
      script: {
        turns: [
          {
            emit: [
              assistant,
              hook,
              {
                type: "result",
                subtype: "success",
                result: "ok",
                usage: { input_tokens: 42, output_tokens: 17 },
              },
            ],
          },
        ],
      },
      resetSession: true,
    });

    expect(result.inputTokens).toBe(42);
    expect(result.outputTokens).toBe(17);
    cleanupTurn(result);
  }, 20000);
});
