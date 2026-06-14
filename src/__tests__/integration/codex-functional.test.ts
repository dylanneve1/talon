/**
 * Functional tests for the **codex** backend through the production dispatcher,
 * driven by the stub `codex` binary (`stub-codex/fake-codex.mjs`).
 *
 * Mirrors `talon-mcp-functional.test.ts` (the claude harness) but for codex's
 * structurally-different transport: the codex-sdk spawns `codex exec
 * --experimental-json` once per turn and reads `ThreadEvent` JSONL from stdout.
 * These tests exercise:
 *   - text delivery via the `end_turn` MCP tool → gateway (the production path)
 *   - `mcp_tool_call` items surfacing as `onToolUse`
 *   - trailing `agent_message` prose handling
 *   - the real `buildCodexMcpServers` → `--config` argv → stub MCP reconstruction
 *
 * Gated on the stub being present (always true in-repo).
 */
import { describe, it, expect, afterAll } from "vitest";
import { runCodexTurn, teardownCodexBootstrap } from "./codex-bootstrap.js";
import { makeRecordingHandler } from "./recording-handler.js";
import { endTurnTurn, proseTurn, mcpToolCall } from "./stub-codex/helpers.js";

describe("codex backend — stub functional (MCP + gateway)", () => {
  const recording = makeRecordingHandler({ seed: 5000 });

  afterAll(() => {
    teardownCodexBootstrap();
  });

  it("delivers text via end_turn MCP tool → gateway send_message", async () => {
    recording.reset();
    const replyText = `codex-functional-${Date.now()}`;

    const turn = await runCodexTurn({
      prompt: "say hello",
      script: { dispatchMcp: true, turns: [endTurnTurn(replyText)] },
      resetSession: true,
      bootstrap: {
        frontend: "telegram",
        gatewayHandler: recording.handler,
      },
    });

    if (
      turn.toolUses.length === 0 &&
      recording.byAction("send_message").length === 0
    ) {
      // Surface the stub log to make wiring failures debuggable.
      console.error("codex protocol log:\n" + turn.protocolLog.join("\n"));
    }

    // onToolUse fired for the end_turn mcp_tool_call.
    const endTurnCall = turn.toolUses.find((t) => t.name.endsWith("end_turn"));
    expect(endTurnCall, "expected an end_turn tool use").toBeDefined();

    // The recording handler captured the delivery routed through the real
    // SDK → MCP → bridge → gateway chain.
    const sends = recording.byAction("send_message");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(sends[0].body.text).toBe(replyText);

    // The stub's protocol log proves a real MCP tools/call happened.
    const mcpLines = turn.protocolLog.filter((l) =>
      l.includes("MCP tools/call"),
    );
    expect(mcpLines.length).toBeGreaterThanOrEqual(1);
  }, 45_000);

  it("surfaces a non-delivery mcp_tool_call via onToolUse", async () => {
    recording.reset();

    const turn = await runCodexTurn({
      prompt: "react please",
      script: {
        dispatchMcp: true,
        turns: [
          {
            emit: [
              mcpToolCall("telegram-tools", "react", {
                message_id: 1,
                emoji: "👍",
              }),
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

    const reactCall = turn.toolUses.find((t) => t.name.endsWith("react"));
    expect(reactCall, "expected a react tool use").toBeDefined();
    expect(recording.byAction("react").length).toBeGreaterThanOrEqual(1);
  }, 45_000);

  it("returns usage + completes on a prose-only turn (no delivery tool)", async () => {
    recording.reset();

    const turn = await runCodexTurn({
      prompt: "just think",
      script: { turns: [proseTurn("internal reasoning text")] },
      resetSession: true,
      bootstrap: {
        frontend: "telegram",
        gatewayHandler: recording.handler,
      },
    });

    // Codex's agent_message becomes the turn's response text.
    expect(turn.text).toContain("internal reasoning text");
    expect(turn.durationMs).toBeGreaterThan(0);
  }, 45_000);
});
