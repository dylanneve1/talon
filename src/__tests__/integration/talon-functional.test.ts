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

describe.skipIf(!stubReady)("Talon functional — bootstrap", () => {
  it("discovers the stub's advertised models through the production initAgent path", async () => {
    // No `registerClaudeModelsStatic` workaround — the stub advertises models
    // in its init handshake response, the production model-discovery path
    // pulls them out of `q.supportedModels()`, tests run through unmodified
    // bootstrap.
    await import("./talon-bootstrap.js").then((m) => m.ensureBooted());
    const { getModels } = await import("../../core/models.js");
    const ids = getModels().map((m) => m.id);
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("default");
    // The stub also advertises an opus model; if discovery is real, we see it.
    expect(ids).toContain("claude-opus-4-7");
  }, 20000);
});

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

// ── Flow-violation contract ────────────────────────────────────────────────
//
// These tests cover the production rule: every turn MUST call a turn-
// terminator tool (`end_turn`, `send`, or `react`). When the SDK loop ends
// without one, the handler re-prompts with `[FLOW VIOLATION]` so the model
// can correct, up to FLOW_VIOLATION_MAX_RETRIES (3) times. Silent drop
// without retry would mean the user gets no response with no observability
// — the failure mode we explicitly guard against.

describe.skipIf(!stubReady)("Talon functional — flow violation", () => {
  afterAll(() => {
    teardownBootstrap();
  });

  // Note on infrastructure: each call to `handleMessage` spawns a fresh stub
  // subprocess, which resets its `turnIndex` to 0. So a recursive retry from
  // the handler doesn't fire `script.turns[1]` — instead, the new stub
  // re-fires `script.turns[0]`. This means we can verify that re-prompts
  // FIRE (via protocol-log inspection of STDIN messages) but cannot test
  // "model recovers via turn 2 of script" without infrastructure changes.
  // The unit assertion that matters most — "re-prompt was attempted" — is
  // fully testable via the protocol log.

  it("re-prompts when model produces trailing prose without end_turn", async () => {
    const result = await runTalonTurn({
      prompt: "say hi",
      script: {
        // Every script turn fires the same broken assistant message — each
        // recursive retry re-spawns the stub which starts at turnIndex=0.
        turns: [
          { emit: [assistantText("forgot to call end_turn"), successResult()] },
        ],
      },
      resetSession: true,
    });

    // Re-prompt fired — the protocol log contains the synthetic reminder.
    const reminderLine = result.protocolLog.find(
      (line) =>
        line.includes("STDIN:") &&
        line.includes("Your previous turn ended without calling a delivery"),
    );
    expect(reminderLine).toBeDefined();
    cleanupTurn(result);
  }, 25000);

  it("re-prompts when model does tool calls but no end_turn (the canonical no-delivery case)", async () => {
    // This is the bug Dylan reported on 2026-05-12 — model ran a Bash-style
    // tool, got the result, then exited without calling end_turn. Previously
    // the handler would silently drop. Now it must re-prompt.
    const result = await runTalonTurn({
      prompt: "fetch something",
      script: {
        turns: [
          {
            emit: [
              {
                type: "assistant",
                message: {
                  stop_reason: "end_turn",
                  content: [
                    {
                      type: "tool_use",
                      id: "tu_bash_1",
                      name: "Bash",
                      input: { command: "echo hi" },
                    },
                  ],
                },
              },
              {
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "tu_bash_1",
                      content: [{ type: "text", text: "hi\n" }],
                    },
                  ],
                },
              },
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
    });

    const reminderLine = result.protocolLog.find(
      (line) =>
        line.includes("STDIN:") &&
        line.includes("Your previous turn ended without calling a delivery"),
    );
    expect(reminderLine).toBeDefined();
    cleanupTurn(result);
  }, 25000);

  it("re-prompts up to FLOW_VIOLATION_MAX_RETRIES (3) times before giving up", async () => {
    // Previous behavior: re-prompt once, then silent-drop on the second
    // violation. New behavior: re-prompt up to 3 times before accepting
    // the drop. The script's single turn fires identically on each retry
    // (the stub re-spawns at turnIndex=0), so a pathological model that
    // never recovers gets exactly 3 reminders before the handler gives up.
    const result = await runTalonTurn({
      prompt: "stubborn model",
      script: {
        turns: [{ emit: [assistantText("never recovers"), successResult()] }],
      },
      resetSession: true,
    });

    // Exactly 3 [FLOW VIOLATION] reminders — one per retry. If the cap
    // weren't enforced, this would loop indefinitely; if the old behavior
    // were in place (single retry then accept drop), this would be 1.
    const reminderCount = result.protocolLog.filter(
      (line) =>
        line.includes("STDIN:") &&
        line.includes("Your previous turn ended without calling a delivery"),
    ).length;
    expect(reminderCount).toBe(3);
    cleanupTurn(result);
  }, 30000);

  it("does NOT re-prompt when model explicitly closes with end_turn() (no args)", async () => {
    // `end_turn()` with no arguments is the explicit "I chose not to reply"
    // close. This is the ONLY legitimate way to end a turn without delivery,
    // and the handler must respect it without re-prompting.
    const result = await runTalonTurn({
      prompt: "be quiet",
      script: {
        turns: [{ emit: [...endTurnWithText(""), successResult()] }],
      },
      resetSession: true,
    });

    // The reminder body has a distinctive phrase that only appears in the
    // synthetic re-prompt; using a system-prompt-stable phrase risks false
    // positives if Talon's system prompt ever mentions `[FLOW VIOLATION]`.
    const reminderCount = result.protocolLog.filter(
      (line) =>
        line.includes("STDIN:") &&
        line.includes("Your previous turn ended without calling a delivery"),
    ).length;
    expect(reminderCount).toBe(0);
    // No user-visible text (empty end_turn).
    expect(deliveredText(result.toolUses)).toBe("");
    cleanupTurn(result);
  }, 20000);
});
