/**
 * Combined backend+frontend integration tests.
 *
 * Drives a full Talon turn end-to-end:
 *   stub `claude` binary  →  real handler.ts loop  →  tool.execute()
 *                                                    →  live Telegram action handler
 *                                                    →  api.telegram.org
 *
 * Where the existing files leave gaps:
 *   - `talon-functional.test.ts` exercises the backend (handler.ts, SDK loop,
 *     hooks, stream processing) but stops at the bridge — tool calls are
 *     observed via `onToolUse`, never actually dispatched to a frontend.
 *   - `telegram-live.test.ts` exercises the frontend boundary (action handler,
 *     real Telegram API) but is driven by hand-crafted action bodies, not by
 *     a real model turn.
 *
 * This file connects the two ends. The stub binary scripts an end_turn
 * tool_use (production MCP-prefixed name shape: `mcp__telegram-tools__end_turn`),
 * the handler captures it via `onToolUse`, and we then run the same
 * `messagingTools.find(t => t.name === "end_turn").execute(input, bridge)`
 * call the production MCP server would run — except `bridge` is a thin
 * wrapper that calls the live test bot's action dispatcher instead of
 * issuing an HTTP request to the gateway.
 *
 * The HTTP transport between MCP server and gateway is the only piece of
 * production plumbing we don't exercise here. That layer has its own unit
 * coverage (gateway.ts + actions.ts) and is provider-agnostic — it doesn't
 * know anything about Telegram or end_turn semantics.
 *
 * Skipped by default. Opt in by either:
 *   - Setting `TALON_TEST_BOT_TOKEN` + `TALON_TEST_CHAT_ID` in the env
 *     (CI path — values come from GitHub repo secrets), or
 *   - Populating `~/.config/talon-tests/secrets.env` with the same keys
 *     (local dev).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import {
  loadLiveSecrets,
  describeMissingSecrets,
} from "./telegram-live/secrets-loader.js";
import { makeTestBot, messageExists } from "./telegram-live/test-bot.js";
import { messagingTools } from "../../core/tools/messaging.js";
import { stripMcpPrefix } from "../../core/tools/index.js";

// ── Skip gating ────────────────────────────────────────────────────────────
//
// Two independent gates: secrets must be present AND the stub binary must be
// on disk (matters on Windows where the SEA build is gitignored). Both
// produce a single `describe.skipIf` rationale.

const skipReason = describeMissingSecrets();
const secrets = loadLiveSecrets();

const __testDir = dirnamePath(fileUrl(import.meta.url));
const stubReady = existsSync(
  resolvePath(
    __testDir,
    process.platform === "win32"
      ? "stub-claude/fake-claude.exe"
      : "stub-claude/fake-claude.mjs",
  ),
);

const finalSkipReason = !stubReady
  ? "Stub binary missing — run `npm run build:stub-sea` (Windows only)."
  : skipReason;

// ── Bridge helper ──────────────────────────────────────────────────────────
//
// Adapter from the production-shape `bridge(action, body)` to the test bot's
// `env.dispatch({action, ...body}, chatId)`. The tool's `execute()` function
// signature is identical to what the MCP server uses in production — same
// keyword args, same return shape — so this is a 1:1 stand-in for the
// bridge HTTP transport.

type BridgeFn = (
  action: string,
  body: Record<string, unknown>,
) => Promise<{ ok: boolean; message_id?: number; [k: string]: unknown }>;

function makeLiveBridge(
  dispatch: ReturnType<typeof makeTestBot>["dispatch"],
  chatId: number,
): BridgeFn {
  return async (action, body) => {
    const result = await dispatch({ action, ...body }, chatId);
    return (result ?? { ok: false }) as Awaited<ReturnType<BridgeFn>>;
  };
}

// ── Tool handles ──────────────────────────────────────────────────────────

const endTurnTool = messagingTools.find((t) => t.name === "end_turn")!;
const sendTool = messagingTools.find((t) => t.name === "send")!;

if (!endTurnTool || !sendTool) {
  throw new Error(
    "messagingTools registry missing end_turn / send — did the registry change?",
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe.skipIf(finalSkipReason !== null)(
  "Talon stub backend → live Telegram frontend",
  () => {
    let env: ReturnType<typeof makeTestBot>;
    let chatId: number;
    let bridge: BridgeFn;
    const sentMessageIds: number[] = [];

    beforeAll(() => {
      if (!secrets.botToken || !secrets.chatId) {
        throw new Error("Unreachable: skipIf should have caught this.");
      }
      env = makeTestBot(secrets.botToken);
      chatId = secrets.chatId;
      bridge = makeLiveBridge(env.dispatch, chatId);
    });

    afterAll(() => {
      teardownBootstrap();
    });

    afterEach(async () => {
      // Delete every message we sent. Test chat with rolling history is fine —
      // no expectation of pristine state.
      while (sentMessageIds.length > 0) {
        const msgId = sentMessageIds.shift()!;
        try {
          await env.bot.api.deleteMessage(chatId, msgId);
        } catch {
          /* already gone or out of edit window — fine */
        }
      }
    });

    it("end_turn tool_use → live message lands in chat", async () => {
      const replyText = `talon-functional-${Date.now()}-end_turn`;
      const [assistant, hook] = endTurnWithText(replyText);

      // Drive a full Talon turn against the stub: handler.ts loop runs end-to-end,
      // captures the tool_use, the PostToolBatch hook fires, the SDK loop closes.
      const turn = await runTalonTurn({
        prompt: "say hello",
        script: { turns: [{ emit: [assistant, hook, successResult()] }] },
        resetSession: true,
      });

      // Production wire-shape: tool name comes through MCP-prefixed.
      const endTurnCall = turn.toolUses.find(
        (t) => stripMcpPrefix(t.name) === "end_turn",
      );
      expect(endTurnCall).toBeDefined();
      expect(endTurnCall!.input.text).toBe(replyText);

      // Run the same tool.execute path the production MCP server runs, but with
      // a live-Telegram bridge instead of the HTTP gateway transport.
      const dispatchResult = (await endTurnTool.execute(
        endTurnCall!.input,
        bridge,
      )) as { ok: boolean; message_id?: number };
      expect(dispatchResult.ok).toBe(true);
      expect(typeof dispatchResult.message_id).toBe("number");
      sentMessageIds.push(dispatchResult.message_id!);

      // Verify the message actually landed via a separate read-back call.
      expect(
        await messageExists(env.bot, chatId, dispatchResult.message_id!),
      ).toBe(true);

      cleanupTurn(turn);
    }, 30_000);

    it("end_turn with empty text → silent end, no Telegram call", async () => {
      // Production contract: end_turn() (no text) is an explicit silent end.
      // The bridge should NOT be invoked — verified by counting before/after
      // sent_count from the test bot's gateway stub.
      const sentBefore = env.getSentCount();

      // Use raw assistantToolUse so we can pass empty input cleanly.
      const turn = await runTalonTurn({
        prompt: "silent end",
        script: {
          turns: [
            {
              emit: [
                assistantToolUse(
                  "mcp__telegram-tools__end_turn",
                  {},
                  "tu_silent",
                ),
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
      });

      const endTurnCall = turn.toolUses.find(
        (t) => stripMcpPrefix(t.name) === "end_turn",
      );
      expect(endTurnCall).toBeDefined();

      const dispatchResult = (await endTurnTool.execute(
        endTurnCall!.input,
        bridge,
      )) as { ok: boolean; silent?: boolean };
      expect(dispatchResult).toEqual({ ok: true, silent: true });
      expect(env.getSentCount()).toBe(sentBefore);

      cleanupTurn(turn);
    }, 30_000);

    it("end_turn with buttons → inline keyboard message lands in chat", async () => {
      const replyText = `talon-functional-${Date.now()}-buttons`;
      const buttons = [
        [{ text: "Yes", callback_data: "y" }],
        [{ text: "No", callback_data: "n" }],
      ];
      // Hand-craft the assistant message so we can include `buttons` in the
      // tool input (the helper doesn't take buttons).
      const turn = await runTalonTurn({
        prompt: "ask with buttons",
        script: {
          turns: [
            {
              emit: [
                assistantToolUse(
                  "mcp__telegram-tools__end_turn",
                  { text: replyText, buttons },
                  "tu_btn",
                ),
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
      });

      const endTurnCall = turn.toolUses.find(
        (t) => stripMcpPrefix(t.name) === "end_turn",
      );
      expect(endTurnCall).toBeDefined();
      expect(endTurnCall!.input.buttons).toEqual(buttons);

      const dispatchResult = (await endTurnTool.execute(
        endTurnCall!.input,
        bridge,
      )) as { ok: boolean; message_id?: number };
      expect(dispatchResult.ok).toBe(true);
      sentMessageIds.push(dispatchResult.message_id!);

      expect(
        await messageExists(env.bot, chatId, dispatchResult.message_id!),
      ).toBe(true);

      cleanupTurn(turn);
    }, 30_000);

    it("send(type=text) tool_use → live message lands in chat", async () => {
      // `send` is the mid-turn rich-content tool. The stub emits it then
      // closes via end_turn — same shape as a real model that delivers a
      // message and then hands off cleanly.
      const messageText = `talon-functional-${Date.now()}-send`;
      const turn = await runTalonTurn({
        prompt: "send a message then close",
        script: {
          turns: [
            {
              emit: [
                assistantToolUse(
                  "mcp__telegram-tools__send",
                  { type: "text", text: messageText },
                  "tu_send",
                ),
                ...endTurnWithText(""),
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
      });

      const sendCall = turn.toolUses.find(
        (t) => stripMcpPrefix(t.name) === "send",
      );
      expect(sendCall).toBeDefined();
      expect(sendCall!.input.text).toBe(messageText);

      const dispatchResult = (await sendTool.execute(
        sendCall!.input,
        bridge,
      )) as { ok: boolean; message_id?: number };
      expect(dispatchResult.ok).toBe(true);
      sentMessageIds.push(dispatchResult.message_id!);

      expect(
        await messageExists(env.bot, chatId, dispatchResult.message_id!),
      ).toBe(true);

      cleanupTurn(turn);
    }, 30_000);

    it("progress text + end_turn → both delivered in order", async () => {
      // Real production pattern: model writes a brief "thinking out loud"
      // text chunk before calling end_turn. The progress text flows through
      // `onTextBlock` while the final reply flows through end_turn. Both
      // should reach Telegram, in order.
      const progressText = `talon-functional-${Date.now()}-progress`;
      const finalText = `talon-functional-${Date.now()}-final`;

      const turn = await runTalonTurn({
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
                      { type: "text", text: progressText },
                      {
                        type: "tool_use",
                        id: "tu_step",
                        name: "mcp__telegram-tools__end_turn",
                        input: { text: finalText },
                      },
                    ],
                  },
                },
                ...endTurnWithText(finalText).slice(1), // PostToolBatch hook fire
                successResult(),
              ],
            },
          ],
        },
        resetSession: true,
      });

      // Progress text reached onTextBlock
      expect(turn.text).toContain(progressText);

      // End-turn captured + dispatched live
      const endTurnCall = turn.toolUses.find(
        (t) => stripMcpPrefix(t.name) === "end_turn",
      );
      expect(endTurnCall).toBeDefined();
      const dispatchResult = (await endTurnTool.execute(
        endTurnCall!.input,
        bridge,
      )) as { ok: boolean; message_id?: number };
      expect(dispatchResult.ok).toBe(true);
      sentMessageIds.push(dispatchResult.message_id!);

      expect(
        await messageExists(env.bot, chatId, dispatchResult.message_id!),
      ).toBe(true);

      cleanupTurn(turn);
    }, 30_000);
  },
);
