/**
 * Functional tests for the **kilo** backend through the production dispatcher,
 * driven by the SAME in-process fake HTTP server as opencode (kilo is an
 * opencode fork exposing the same wire API). Proves the one fake server covers
 * both backends, and surfaces any kilo-specific divergence.
 */
import { describe, it, expect, afterAll, vi } from "vitest";

// Set the fixed port BEFORE the kilo module reads KILO_PORT at eval.
vi.hoisted(() => {
  process.env.KILO_PORT = process.env.KILO_STUB_PORT ?? "4391";
});

import { runKiloTurn, teardownKiloBootstrap } from "./kilo-bootstrap.js";
import { makeRecordingHandler } from "./recording-handler.js";

describe("kilo backend — stub functional (HTTP + SSE + MCP)", () => {
  const recording = makeRecordingHandler({ seed: 7000 });

  afterAll(async () => {
    await teardownKiloBootstrap();
  });

  it("delivers plain assistant text (text-preferred contract)", async () => {
    recording.reset();
    const replyText = `kilo-text-${Date.now()}`;

    const turn = await runKiloTurn({
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

    const turn = await runKiloTurn({
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

    expect(
      turn.mcpRegistrations.some((n) => n.startsWith("talon-tools-")),
    ).toBe(true);
    expect(turn.toolUses.find((t) => t.name.endsWith("react"))).toBeDefined();
    expect(recording.byAction("react").length).toBeGreaterThanOrEqual(1);
  }, 45_000);
});
