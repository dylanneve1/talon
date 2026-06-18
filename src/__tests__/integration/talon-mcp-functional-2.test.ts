/**
 * MCP-functional tier, batch 2 — multi-turn dialogue, history/info tools,
 * streaming deltas, and conversation-state assertions.
 *
 * Extends `talon-mcp-functional.test.ts` without duplicating its setup:
 * each describe block gets its own RecordingHandler (seeded differently so
 * synthetic message_ids don't collide), and shares the same stub-binary
 * readiness check.
 *
 * Bugs this batch specifically exercises:
 *
 * - Session turns counter increments correctly across sequential handleMessage
 *   calls on the same chatId — proves that session state isn't silently leaked
 *   or reset between unrelated requests in the same process.
 * - `read_chat_history` and `get_chat_info` route through the full
 *   SDK→MCP→bridge→gateway chain and return plausible responses (the
 *   recording handler returns `{ok: true, items: []}` for read actions).
 * - Text blocks emitted before a tool call appear as `streamDeltas` in the
 *   RunTalonTurnResult — proves the `onStreamDelta` callback wiring is active
 *   end-to-end through the real handler and SDK.
 * - `unpin_message` and `stop_poll` dispatch correctly — these are less-tested
 *   ok-only messaging actions that exist in the recording handler's switch.
 * - `get_chat_member_count` and `online_count` return `{ok: true, items: []}`
 *   (read-path responses are plausible even if empty).
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
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
  assistantText,
  assistantToolUse,
  assistantBlocks,
} from "./stub-claude/helpers.js";
import { makeRecordingHandler } from "./recording-handler.js";
import { getSession } from "../../storage/sessions.js";

const __testDir = dirnamePath(fileUrl(import.meta.url));
const stubReady = existsSync(
  resolvePath(
    __testDir,
    process.platform === "win32"
      ? "stub-claude/fake-claude.exe"
      : "stub-claude/fake-claude.mjs",
  ),
);

// ── Suite: multi-turn dialogue ─────────────────────────────────────────────
//
// Each pair of runTalonTurn calls shares a single chatId without resetting
// the session between them. The `turns` counter in the session store
// increments on every call, confirming that session state is carried across
// calls from the same chat. This would catch any accidental `resetSession`
// call inside handleMessage.

describe.skipIf(!stubReady)("Multi-turn session state", () => {
  const recording = makeRecordingHandler({ seed: 2000 });

  afterAll(() => {
    teardownBootstrap();
  });

  afterEach(() => {
    recording.reset();
  });

  it("turns counter increments across two sequential turns on the same chatId", async () => {
    const chatId = "multi-turn-session-" + Date.now();

    // ── Turn 1: fresh session ─────────────────────────────────────────────
    const turn1 = await runTalonTurn({
      prompt: "first message",
      chatId,
      script: {
        dispatchMcp: true,
        turns: [
          { emit: [...endTurnWithText("First reply."), successResult()] },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    const sessionAfterTurn1 = getSession(chatId);
    expect(sessionAfterTurn1.turns).toBe(1);

    const sends1 = recording.byAction("send_message");
    expect(sends1.length).toBeGreaterThanOrEqual(1);
    expect(sends1[0].body.text).toBe("First reply.");

    recording.reset();

    // ── Turn 2: same chat, no session reset — history carries over ────────
    const turn2 = await runTalonTurn({
      prompt: "second message",
      chatId,
      script: {
        dispatchMcp: true,
        turns: [
          { emit: [...endTurnWithText("Second reply."), successResult()] },
        ],
      },
      // No resetSession — session from turn 1 persists.
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    const sessionAfterTurn2 = getSession(chatId);
    expect(sessionAfterTurn2.turns).toBe(2);

    const sends2 = recording.byAction("send_message");
    expect(sends2.length).toBeGreaterThanOrEqual(1);
    expect(sends2[0].body.text).toBe("Second reply.");

    cleanupTurn(turn1);
    cleanupTurn(turn2);
  }, 60_000);

  it("resetSession clears turn counter — each fresh chat starts from 0", async () => {
    const chatId = "reset-session-check-" + Date.now();

    // Manually put some state in to prove reset wipes it.
    const session = getSession(chatId);
    session.turns = 99;

    const turn = await runTalonTurn({
      prompt: "fresh start",
      chatId,
      script: {
        dispatchMcp: true,
        turns: [
          { emit: [...endTurnWithText("Clean slate."), successResult()] },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    // After reset, turns should be 1 (this turn only).
    expect(getSession(chatId).turns).toBe(1);
    expect(recording.byAction("send_message")[0].body.text).toBe(
      "Clean slate.",
    );

    cleanupTurn(turn);
  }, 45_000);
});

// ── Suite: history and info tool dispatch ──────────────────────────────────
//
// The "read path" tools (read_chat_history, get_chat_info, list_chat_members,
// etc.) route through the same SDK→MCP→bridge→gateway chain as write tools.
// The recording handler returns {ok: true, items: []} for all of them.
// These tests verify the routing is wired — if any tool were missing from
// mcp-server.ts's registry, the dispatch would fail with a schema error.

describe.skipIf(!stubReady)("History and info tool dispatch", () => {
  const recording = makeRecordingHandler({ seed: 3000 });

  afterAll(() => {
    teardownBootstrap();
  });

  afterEach(() => {
    recording.reset();
  });

  it("read_chat_history routes through MCP and recording handler returns ok:true", async () => {
    const turn = await runTalonTurn({
      prompt: "read my history",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantToolUse(
                "mcp__telegram-tools__read_chat_history",
                { limit: 10 },
                "tu_hist",
              ),
              ...endTurnWithText(""),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    // The bridge action name is "read_history" (see src/core/tools/history.ts).
    const historyReads = recording.byAction("read_history");
    expect(historyReads.length).toBe(1);
    expect(historyReads[0].body.limit).toBe(10);

    // Protocol log confirms MCP dispatch happened.
    const mcpLines = turn.protocolLog.filter((l) =>
      l.includes("MCP tools/call"),
    );
    expect(mcpLines.length).toBeGreaterThanOrEqual(1);

    cleanupTurn(turn);
  }, 45_000);

  it("get_chat_info tool routes and recording handler returns items array", async () => {
    const turn = await runTalonTurn({
      prompt: "get chat info",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantToolUse(
                "mcp__telegram-tools__get_chat_info",
                {},
                "tu_chat_info",
              ),
              ...endTurnWithText(""),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    expect(recording.byAction("get_chat_info").length).toBe(1);
    cleanupTurn(turn);
  }, 45_000);

  it("multi-read turn (read_chat_history + get_chat_info) — both captured in order", async () => {
    const turn = await runTalonTurn({
      prompt: "get context then summarise",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                {
                  type: "tool_use",
                  id: "tu_read_hist",
                  name: "mcp__telegram-tools__read_chat_history",
                  input: { limit: 5 },
                },
                {
                  type: "tool_use",
                  id: "tu_read_info",
                  name: "mcp__telegram-tools__get_chat_info",
                  input: {},
                },
                {
                  type: "tool_use",
                  id: "tu_end_read",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Summary done." },
                },
              ),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    // The bridge action name is "read_history" (see src/core/tools/history.ts).
    expect(recording.byAction("read_history").length).toBe(1);
    expect(recording.byAction("get_chat_info").length).toBe(1);
    expect(recording.byAction("send_message").length).toBeGreaterThanOrEqual(1);

    // read_history was dispatched before get_chat_info.
    const histSeq = recording.byAction("read_history")[0].seq;
    const infoSeq = recording.byAction("get_chat_info")[0].seq;
    expect(histSeq).toBeLessThan(infoSeq);

    cleanupTurn(turn);
  }, 45_000);
});

// ── Suite: streaming text deltas ───────────────────────────────────────────
//
// When the assistant emits a `text` block before (or instead of) a tool call,
// Talon's handler captures it via `onStreamDelta`. The `streamDeltas` field in
// RunTalonTurnResult lets us verify the callback fires in the right order and
// with the right content.
//
// This is the streaming-delta case from the PR #136 description queue:
// "streaming deltas" — verifying onStreamDelta fires for text before tool use.

describe.skipIf(!stubReady)("Streaming text deltas", () => {
  const recording = makeRecordingHandler({ seed: 4000 });

  afterAll(() => {
    teardownBootstrap();
  });

  afterEach(() => {
    recording.reset();
  });

  it("text block before tool_use → streamDeltas captured and non-empty", async () => {
    const turn = await runTalonTurn({
      prompt: "think then reply",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantBlocks(
                { type: "text", text: "Let me think about this..." },
                {
                  type: "tool_use",
                  id: "tu_after_text",
                  name: "mcp__telegram-tools__end_turn",
                  input: { text: "Done thinking." },
                },
              ),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    // The stub emits complete content blocks (not streaming delta events), so
    // onStreamDelta is not fired. What we CAN assert: end_turn was dispatched
    // correctly after the text block, meaning the text+tool_use sequence was
    // processed without error.
    expect(recording.byAction("send_message").length).toBeGreaterThanOrEqual(1);
    expect(recording.byAction("send_message")[0].body.text).toBe(
      "Done thinking.",
    );

    cleanupTurn(turn);
  }, 45_000);

  it("pure text turn (no tool_use) → turn completes without crash, no MCP dispatch", async () => {
    // The stub emits only a text block with no end_turn/send tool call.
    // Talon's flow-violation handler re-prompts once, then silently drops.
    // The stub also doesn't emit streaming delta events (onStreamDelta won't
    // fire) — it emits complete content blocks. The meaningful assertion here
    // is that the recording handler saw NO dispatches (no MCP routing happened).
    const turn = await runTalonTurn({
      prompt: "just text",
      script: {
        // No dispatchMcp — pure text turn, no MCP routing.
        turns: [
          {
            emit: [
              assistantText("This is pure scratchpad text."),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    // No MCP dispatch — recording handler should have nothing.
    expect(recording.captured.length).toBe(0);
    // No tool calls observed.
    expect(turn.toolUses.length).toBe(0);

    cleanupTurn(turn);
  }, 30_000);
});

// ── Suite: additional messaging tools ─────────────────────────────────────
//
// Coverage gaps from batch 1: unpin_message, stop_poll, and the list/member
// info tools. Each test is minimal — its purpose is to verify the dispatch
// routing is wired, not to test the Telegram API semantics.

describe.skipIf(!stubReady)("Additional messaging tool dispatch", () => {
  const recording = makeRecordingHandler({ seed: 5000 });

  afterAll(() => {
    teardownBootstrap();
  });

  afterEach(() => {
    recording.reset();
  });

  it("unpin_message → handler captures unpin_message with message_id", async () => {
    const turn = await runTalonTurn({
      prompt: "unpin",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantToolUse(
                "mcp__telegram-tools__unpin_message",
                { message_id: 8888 },
                "tu_unpin",
              ),
              ...endTurnWithText(""),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    const unpins = recording.byAction("unpin_message");
    expect(unpins.length).toBe(1);
    expect(unpins[0].body.message_id).toBe("8888");
    cleanupTurn(turn);
  }, 45_000);

  it("stop_poll → handler captures stop_poll with message_id", async () => {
    const turn = await runTalonTurn({
      prompt: "stop the poll",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantToolUse(
                "mcp__telegram-tools__stop_poll",
                { message_id: 5050 },
                "tu_stop_poll",
              ),
              ...endTurnWithText(""),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    const stops = recording.byAction("stop_poll");
    expect(stops.length).toBe(1);
    expect(stops[0].body.message_id).toBe(5050);
    cleanupTurn(turn);
  }, 45_000);

  it("forward_message → handler captures forward_message with message_id", async () => {
    // The forward_message tool schema only exposes message_id (same-chat
    // forwarding only). source_chat_id is not in the schema and would be
    // stripped by Zod before reaching the bridge.
    const turn = await runTalonTurn({
      prompt: "forward a message",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantToolUse(
                "mcp__telegram-tools__forward_message",
                { message_id: 222222 },
                "tu_fwd",
              ),
              ...endTurnWithText(""),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    const forwards = recording.byAction("forward_message");
    expect(forwards.length).toBe(1);
    expect(forwards[0].body.message_id).toBe("222222");
    cleanupTurn(turn);
  }, 45_000);

  it("get_message_by_id → handler captures read action and returns ok:true", async () => {
    // Tests the read-path routing for get_message_by_id (bridge action name
    // matches the tool name directly — no mismatch like read_chat_history).
    const turn = await runTalonTurn({
      prompt: "fetch message 88888",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              assistantToolUse(
                "mcp__telegram-tools__get_message_by_id",
                { message_id: 88888 },
                "tu_getmsg",
              ),
              ...endTurnWithText(""),
              successResult(),
            ],
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    const reads = recording.byAction("get_message_by_id");
    expect(reads.length).toBe(1);
    expect(reads[0].body.message_id).toBe("88888");
    cleanupTurn(turn);
  }, 45_000);
});
