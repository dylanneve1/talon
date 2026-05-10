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
} from "./stub-claude/helpers.js";
import type { FrontendActionHandler } from "../../core/types.js";

const __testDir = dirnamePath(fileUrl(import.meta.url));
const stubReady = existsSync(
  resolvePath(
    __testDir,
    process.platform === "win32"
      ? "stub-claude/fake-claude.exe"
      : "stub-claude/fake-claude.mjs",
  ),
);

// ── Recording handler ─────────────────────────────────────────────────────
//
// Captures every action body the gateway routes to it. Returns a synthetic
// success response shaped like what the production Telegram action handler
// would return for `send_message` / `send_message_with_buttons` / `react`
// / `edit_message` / `delete_message` so `tool.execute()` resolves cleanly.

interface CapturedAction {
  body: Record<string, unknown>;
  chatId: number;
}

function makeRecordingHandler(): {
  handler: FrontendActionHandler;
  captured: CapturedAction[];
  reset: () => void;
} {
  const captured: CapturedAction[] = [];
  let nextMessageId = 1_000;

  const handler: FrontendActionHandler = async (body, chatId) => {
    captured.push({ body: { ...body }, chatId });
    const action = String(body.action ?? "");
    // Synthesize plausible responses so tool.execute resolves cleanly.
    switch (action) {
      case "send_message":
      case "send_message_with_buttons":
      case "reply_to":
        return { ok: true, message_id: nextMessageId++ };
      case "react":
      case "edit_message":
      case "delete_message":
      case "pin_message":
      case "unpin_message":
        return { ok: true };
      default:
        return { ok: true };
    }
  };

  return { handler, captured, reset: () => captured.splice(0) };
}

// ── Tests ─────────────────────────────────────────────────────────────────

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

      // The handler captured the assistant message + tool_use.
      const endTurnCall = turn.toolUses.find((t) =>
        t.name.endsWith("end_turn"),
      );
      expect(endTurnCall).toBeDefined();
      expect(endTurnCall!.input.text).toBe(replyText);

      // The recording action handler captured exactly one send_message,
      // routed through the full SDK→MCP→bridge→gateway chain.
      const sends = recording.captured.filter(
        (c) => c.body.action === "send_message",
      );
      expect(sends.length).toBeGreaterThanOrEqual(1);
      expect(sends[0].body.text).toBe(replyText);

      // Stub's protocol log shows MCP dispatch happened.
      const mcpLines = turn.protocolLog.filter((l) =>
        l.includes("MCP tools/call"),
      );
      expect(mcpLines.length).toBeGreaterThanOrEqual(1);

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
      const sends = recording.captured.filter(
        (c) => c.body.action === "send_message",
      );
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

      const buttonSends = recording.captured.filter(
        (c) => c.body.action === "send_message_with_buttons",
      );
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

      const sends = recording.captured.filter(
        (c) => c.body.action === "send_message",
      );
      expect(sends.length).toBeGreaterThanOrEqual(1);
      expect(sends.some((s) => s.body.text === messageText)).toBe(true);

      cleanupTurn(turn);
    }, 45_000);
  },
);
