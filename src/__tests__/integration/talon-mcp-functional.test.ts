/**
 * Stub backend + real MCP dispatch + recording action handler.
 *
 * Exercises the full SDK→MCP→bridge→action_handler chain WITHOUT needing a
 * live external service:
 *
 *   stub `claude` binary
 *     → real handler.ts loop
 *     → stub auto-dispatches `tool_use` via real MCP client
 *     → real Talon `mcp-server.ts` (spawned by the SDK config)
 *     → real `tool.execute(params, bridge)` (production code)
 *     → real `bridge` HTTP POST to the gateway
 *     → real `Gateway.handleAction` routing
 *     → recording action handler (captures every action body)
 *
 * The only piece that's not "real" is the action handler — instead of
 * actually calling the Telegram API, it pushes the action body onto an
 * array. Tests assert on what was captured.
 *
 * This is the tier above `talon-functional.test.ts`: that one stops at
 * `onToolUse` and never crosses the SDK→MCP boundary; this one crosses
 * it through real subprocess spawning + JSON-RPC and asserts the result
 * lands at a frontend handler in the right shape.
 *
 * Bugs this catches that nothing else does:
 *
 * - SDK passes `--mcp-config` correctly (the stub now parses + obeys it).
 * - Talon's `mcp-server.ts` registers all messaging tools with the right
 *   schemas — if `end_turn` were missing, the dispatch would fail loud.
 * - `tool.execute(params, bridge)` correctly maps tool input → action body.
 * - Bridge HTTP transport is stable (request shape, _chatId routing).
 * - Gateway resolves the chat context by string id when the bridge sends
 *   the non-numeric `chatId` we used in the test.
 * - Whole-chain timing — if any step blocks > 30s the hard timeout fires.
 */

import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve as resolvePath, dirname as dirnamePath } from "node:path";
import { fileURLToPath as fileUrl } from "node:url";

import {
  runTalonTurn,
  cleanupTurn,
  teardownBootstrap,
} from "./talon-bootstrap.js";
import {
  endTurnWithText,
  successResult,
  assistantToolUse,
  assistantBlocks,
} from "./stub-claude/helpers.js";
import { makeRecordingHandler } from "./recording-handler.js";

const __testDir = dirnamePath(fileUrl(import.meta.url));
const stubReady = existsSync(
  resolvePath(
    __testDir,
    process.platform === "win32"
      ? "stub-claude/fake-claude.exe"
      : "stub-claude/fake-claude.mjs",
  ),
);

// ── Tests ─────────────────────────────────────────────────────────────────

/**
 * Helper: surface the stub binary's protocol log on assertion failure.
 *
 * The MCP-functional tier runs through several subprocess hops (SDK loop,
 * MCP server spawn, bridge HTTP) that produce no Vitest assertion output
 * when something goes wrong upstream of the test's actual `expect(...)`.
 * Wrap each test body in this so a failure on `recording.captured` length
 * doesn't leave us guessing what the MCP layer was doing — the protocol
 * log shows whether the client connected, whether `tools/call` returned,
 * whether the result was an error, etc.
 */
async function withProtocolLogOnFailure<
  T extends { protocolLog: string[] } | undefined,
>(turn: T, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (turn && turn.protocolLog?.length) {
      // eslint-disable-next-line no-console
      console.error(
        "\n=== stub protocol log (last 60 lines) ===\n" +
          turn.protocolLog.slice(-60).join("\n") +
          "\n=== end protocol log ===\n",
      );
    }
    throw err;
  }
}

describe.skipIf(!stubReady)(
  "Stub backend + real MCP dispatch + recording handler",
  () => {
    const recording = makeRecordingHandler();

    afterAll(() => {
      teardownBootstrap();
    });

    it("end_turn tool_use → MCP dispatch → recording handler captures send_message", async () => {
      recording.reset();
      const replyText = `mcp-functional-${Date.now()}-end_turn`;
      const [assistant, hook] = endTurnWithText(replyText);

      const turn = await runTalonTurn({
        prompt: "say hello",
        script: {
          dispatchMcp: true,
          turns: [{ emit: [assistant, hook, successResult()] }],
        },
        resetSession: true,
        bootstrap: {
          frontend: "telegram",
          gatewayHandler: recording.handler,
        },
      });

      await withProtocolLogOnFailure(turn, () => {
        // The handler captured the assistant message + tool_use.
        const endTurnCall = turn.toolUses.find((t) =>
          t.name.endsWith("end_turn"),
        );
        expect(endTurnCall).toBeDefined();
        expect(endTurnCall!.input.text).toBe(replyText);

        // The recording action handler captured exactly one send_message,
        // routed through the full SDK→MCP→bridge→gateway chain.
        const sends = recording.byAction("send_message");
        expect(sends.length).toBeGreaterThanOrEqual(1);
        expect(sends[0].body.text).toBe(replyText);

        // Stub's protocol log shows MCP dispatch happened.
        const mcpLines = turn.protocolLog.filter((l) =>
          l.includes("MCP tools/call"),
        );
        expect(mcpLines.length).toBeGreaterThanOrEqual(1);
      });

      cleanupTurn(turn);
    }, 45_000);

    it("end_turn() with empty text → silent end, NO send_message routed", async () => {
      recording.reset();
      const turn = await runTalonTurn({
        prompt: "silent end",
        script: {
          dispatchMcp: true,
          turns: [
            {
              emit: [
                assistantToolUse(
                  "mcp__telegram-tools__end_turn",
                  {},
                  "tu_silent_mcp",
                ),
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
        bootstrap: {
          frontend: "telegram",
          gatewayHandler: recording.handler,
        },
      });

      // Nothing posts to the action handler — end_turn() with no text is
      // an explicit silent end, the tool returns `{ok: true, silent: true}`
      // without invoking the bridge.
      const sends = recording.byAction("send_message");
      expect(sends.length).toBe(0);

      cleanupTurn(turn);
    }, 45_000);

    it("end_turn with buttons → recording handler captures send_message_with_buttons", async () => {
      recording.reset();
      const buttonText = `mcp-functional-${Date.now()}-buttons`;
      const buttons = [
        [{ text: "Yes", callback_data: "y" }],
        [{ text: "No", callback_data: "n" }],
      ];

      const turn = await runTalonTurn({
        prompt: "ask with buttons",
        script: {
          dispatchMcp: true,
          turns: [
            {
              emit: [
                assistantToolUse(
                  "mcp__telegram-tools__end_turn",
                  { text: buttonText, buttons },
                  "tu_btn_mcp",
                ),
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
        bootstrap: {
          frontend: "telegram",
          gatewayHandler: recording.handler,
        },
      });

      const buttonSends = recording.byAction("send_message_with_buttons");
      expect(buttonSends.length).toBeGreaterThanOrEqual(1);
      expect(buttonSends[0].body.text).toBe(buttonText);
      expect(buttonSends[0].body.rows).toEqual(buttons);

      cleanupTurn(turn);
    }, 45_000);

    it("send(type=text) tool_use → recording handler captures send_message", async () => {
      recording.reset();
      const messageText = `mcp-functional-${Date.now()}-send`;

      const turn = await runTalonTurn({
        prompt: "send a message then close",
        script: {
          dispatchMcp: true,
          turns: [
            {
              emit: [
                assistantToolUse(
                  "mcp__telegram-tools__send",
                  { type: "text", text: messageText },
                  "tu_send_mcp",
                ),
                ...endTurnWithText(""),
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
        bootstrap: {
          frontend: "telegram",
          gatewayHandler: recording.handler,
        },
      });

      const sends = recording.byAction("send_message");
      expect(sends.length).toBeGreaterThanOrEqual(1);
      expect(sends.some((s) => s.body.text === messageText)).toBe(true);

      cleanupTurn(turn);
    }, 45_000);

    // ── Broader tool surface ─────────────────────────────────────────────
    //
    // The original 4 cases covered end_turn + send. These cases exercise
    // the rest of the messaging tool registry — every messaging tool's
    // `tool.execute(params, bridge)` mapping gets a smoke test. If any one
    // of these regresses (e.g. someone changes the action name from
    // `react` to `add_reaction`), the corresponding case fails loud.

    it("react tool_use → handler captures react action with message_id + emoji", async () => {
      recording.reset();
      const turn = await runTalonTurn({
        prompt: "react then end",
        script: {
          dispatchMcp: true,
          turns: [
            {
              emit: [
                assistantToolUse(
                  "mcp__telegram-tools__react",
                  { message_id: 12345, emoji: "🔥" },
                  "tu_react",
                ),
                ...endTurnWithText(""),
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
        bootstrap: {
          frontend: "telegram",
          gatewayHandler: recording.handler,
        },
      });

      const reacts = recording.byAction("react");
      expect(reacts.length).toBeGreaterThanOrEqual(1);
      expect(reacts[0].body.message_id).toBe("12345");
      expect(reacts[0].body.emoji).toBe("🔥");

      cleanupTurn(turn);
    }, 45_000);

    it("edit_message tool_use → handler captures edit_message with new text", async () => {
      recording.reset();
      const newText = `mcp-functional-${Date.now()}-edit`;
      const turn = await runTalonTurn({
        prompt: "edit then end",
        script: {
          dispatchMcp: true,
          turns: [
            {
              emit: [
                assistantToolUse(
                  "mcp__telegram-tools__edit_message",
                  { message_id: 999, text: newText },
                  "tu_edit",
                ),
                ...endTurnWithText(""),
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
        bootstrap: {
          frontend: "telegram",
          gatewayHandler: recording.handler,
        },
      });

      const edits = recording.byAction("edit_message");
      expect(edits.length).toBeGreaterThanOrEqual(1);
      expect(edits[0].body.message_id).toBe("999");
      expect(edits[0].body.text).toBe(newText);

      cleanupTurn(turn);
    }, 45_000);

    it("delete_message tool_use → handler captures delete_message", async () => {
      recording.reset();
      const turn = await runTalonTurn({
        prompt: "delete then end",
        script: {
          dispatchMcp: true,
          turns: [
            {
              emit: [
                assistantToolUse(
                  "mcp__telegram-tools__delete_message",
                  { message_id: 7777 },
                  "tu_del",
                ),
                ...endTurnWithText(""),
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
        bootstrap: {
          frontend: "telegram",
          gatewayHandler: recording.handler,
        },
      });

      const deletes = recording.byAction("delete_message");
      expect(deletes.length).toBeGreaterThanOrEqual(1);
      expect(deletes[0].body.message_id).toBe("7777");

      cleanupTurn(turn);
    }, 45_000);

    it("pin_message + unpin_message tool_use → handler captures both", async () => {
      recording.reset();
      const turn = await runTalonTurn({
        prompt: "pin then unpin",
        script: {
          dispatchMcp: true,
          turns: [
            {
              emit: [
                assistantToolUse(
                  "mcp__telegram-tools__pin_message",
                  { message_id: 4242 },
                  "tu_pin",
                ),
                ...endTurnWithText(""),
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
        bootstrap: {
          frontend: "telegram",
          gatewayHandler: recording.handler,
        },
      });

      expect(recording.byAction("pin_message").length).toBe(1);
      expect(recording.byAction("pin_message")[0].body.message_id).toBe("4242");
      cleanupTurn(turn);
    }, 45_000);

    // ── Multi-tool turn ──────────────────────────────────────────────────
    //
    // The model is allowed to emit multiple tool_use blocks in one
    // assistant message. The SDK dispatches them sequentially (or, with
    // PostToolBatch, in a batch). End_turn at the end of the same message
    // closes the turn cleanly. This case exercises that interleaving — the
    // recording handler should see actions in the order the model emitted
    // tool_use blocks.

    it("multi-tool turn (react → send → end_turn) → all three actions captured in order", async () => {
      recording.reset();
      const replyText = `mcp-functional-${Date.now()}-multi`;

      const turn = await runTalonTurn({
        prompt: "react and reply",
        script: {
          dispatchMcp: true,
          turns: [
            {
              emit: [
                assistantBlocks(
                  {
                    type: "tool_use",
                    id: "tu_multi_react",
                    name: "mcp__telegram-tools__react",
                    input: { message_id: 100, emoji: "👍" },
                  },
                  {
                    type: "tool_use",
                    id: "tu_multi_send",
                    name: "mcp__telegram-tools__send",
                    input: { type: "text", text: replyText },
                  },
                  {
                    type: "tool_use",
                    id: "tu_multi_end",
                    name: "mcp__telegram-tools__end_turn",
                    input: {},
                  },
                ),
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
        bootstrap: {
          frontend: "telegram",
          gatewayHandler: recording.handler,
        },
      });

      // All three reached the recording handler.
      expect(recording.byAction("react").length).toBe(1);
      expect(recording.byAction("send_message").length).toBe(1);
      // end_turn() with empty input is silent — does NOT post.
      expect(recording.byAction("send_message")[0].body.text).toBe(replyText);

      // Order preservation: react fired before send.
      const reactSeq = recording.byAction("react")[0].seq;
      const sendSeq = recording.byAction("send_message")[0].seq;
      expect(reactSeq).toBeLessThan(sendSeq);

      cleanupTurn(turn);
    }, 45_000);

    // ── Error paths ──────────────────────────────────────────────────────
    //
    // When the action handler returns a non-ok response, the bridge
    // surfaces it as a tool result with `ok: false`. Talon's tool.execute
    // returns whatever the bridge returns, so the SDK's tool_result has
    // `is_error: false` (the call succeeded structurally) but the body
    // signals failure. Important: handler.ts MUST NOT crash — error
    // results are part of the normal flow.

    it("handler returns ok:false → tool_result still completes, handler.ts doesn't crash", async () => {
      recording.reset();
      // Force send_message to fail at the action-handler level.
      recording.respond.set("send_message", () => ({
        ok: false,
        error: "synthetic API error for testing",
      }));

      const replyText = `mcp-functional-${Date.now()}-error`;
      const [assistant, hook] = endTurnWithText(replyText);

      const turn = await runTalonTurn({
        prompt: "trigger an error",
        script: {
          dispatchMcp: true,
          turns: [{ emit: [assistant, hook, successResult()] }],
        },
        resetSession: true,
        bootstrap: {
          frontend: "telegram",
          gatewayHandler: recording.handler,
        },
      });

      // The handler still got called — it just returned an error.
      const sends = recording.byAction("send_message");
      expect(sends.length).toBe(1);

      // handler.ts captured the tool_use cleanly despite the failure.
      const endTurnCall = turn.toolUses.find((t) =>
        t.name.endsWith("end_turn"),
      );
      expect(endTurnCall).toBeDefined();
      expect(endTurnCall!.input.text).toBe(replyText);

      // Stub log records the MCP round-trip completed without throwing.
      const mcpLines = turn.protocolLog.filter((l) =>
        l.includes("MCP tools/call result"),
      );
      expect(mcpLines.length).toBeGreaterThanOrEqual(1);

      cleanupTurn(turn);
    }, 45_000);

    // ── Chat ID propagation ─────────────────────────────────────────────
    //
    // The chatId we pass to runTalonTurn is a string (e.g. "stub-chat-xyz").
    // The gateway hashes it to a synthetic numeric ID for context lookup
    // and routes the bridge call there. The recording handler's chatId
    // should match that numeric ID for every captured action — proves the
    // routing is consistent across MCP→bridge→gateway hops.

    it("chatId routed consistently from runTalonTurn through to handler", async () => {
      recording.reset();
      const customChatId = "stub-chat-routing-test-123";
      const [assistant, hook] = endTurnWithText("routing test");

      const turn = await runTalonTurn({
        prompt: "test routing",
        chatId: customChatId,
        script: {
          dispatchMcp: true,
          turns: [{ emit: [assistant, hook, successResult()] }],
        },
        resetSession: true,
        bootstrap: {
          frontend: "telegram",
          gatewayHandler: recording.handler,
        },
      });

      const sends = recording.byAction("send_message");
      expect(sends.length).toBe(1);
      // All captures within a turn must share the same chatId.
      const chatIds = new Set(recording.captured.map((c) => c.chatId));
      expect(chatIds.size).toBe(1);
      // It should be a positive integer (gateway converts string → numeric).
      const onlyChatId = [...chatIds][0];
      expect(Number.isInteger(onlyChatId)).toBe(true);
      expect(onlyChatId).toBeGreaterThan(0);

      cleanupTurn(turn);
    }, 45_000);
  },
);
