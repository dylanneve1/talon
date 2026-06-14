/**
 * Functional tests for the **opencode** backend (same wire API as kilo) through
 * the production dispatcher, driven by an in-process fake HTTP server.
 *
 * Structural difference vs claude/codex: opencode delivers via plain assistant
 * TEXT (text-preferred contract) read from `session.messages` after the SSE
 * stream signals `session.idle` — not via an `end_turn` tool. MCP tools are
 * for genuine side-effects (react/send).
 */
import { describe, it, expect, afterAll, vi } from "vitest";

// Set the fixed port BEFORE the opencode module reads OPENCODE_PORT at eval.
vi.hoisted(() => {
  process.env.OPENCODE_PORT = process.env.OPENCODE_STUB_PORT ?? "4291";
});

import {
  runOpencodeTurn,
  teardownOpencodeBootstrap,
} from "./opencode-bootstrap.js";
import { makeRecordingHandler } from "./recording-handler.js";

describe("opencode backend — stub functional (HTTP + SSE + MCP)", () => {
  const recording = makeRecordingHandler({ seed: 6000 });

  afterAll(async () => {
    await teardownOpencodeBootstrap();
  });

  it("delivers plain assistant text (text-preferred contract)", async () => {
    recording.reset();
    const replyText = `opencode-text-${Date.now()}`;

    const turn = await runOpencodeTurn({
      prompt: "say hello",
      turn: { emit: [{ type: "text", text: replyText }] },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    expect(turn.text).toContain(replyText);
    expect(turn.durationMs).toBeGreaterThan(0);
  }, 45_000);

  it("routes an MCP tool (react) side-effect through the gateway", async () => {
    recording.reset();

    const turn = await runOpencodeTurn({
      prompt: "react please",
      turn: {
        emit: [
          { type: "text", text: "ok" },
          {
            type: "tool",
            tool: "react",
            input: { message_id: 1, emoji: "👍" },
          },
        ],
      },
      resetSession: true,
      bootstrap: { frontend: "telegram", gatewayHandler: recording.handler },
    });

    // The fake server registered the chat MCP server.
    expect(
      turn.mcpRegistrations.some((n) => n.startsWith("talon-tools-")),
      `expected a talon-tools MCP registration; got ${turn.mcpRegistrations.join(", ")}`,
    ).toBe(true);

    // onToolUse fired for the react tool.
    const reactCall = turn.toolUses.find((t) => t.name.endsWith("react"));
    expect(reactCall, "expected a react tool use").toBeDefined();

    // The tool actually routed to the gateway.
    expect(recording.byAction("react").length).toBeGreaterThanOrEqual(1);
  }, 45_000);
});
