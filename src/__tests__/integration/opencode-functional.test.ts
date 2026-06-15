/**
 * Functional tests for the **opencode** backend (same wire API as kilo) through
 * the production dispatcher, driven by the in-process fake HTTP server via the
 * shared multi-backend harness.
 *
 * Structural difference vs claude/codex: opencode delivers via plain assistant
 * TEXT (text-preferred contract) read from `session.messages` after the SSE
 * stream signals `session.idle` — not via an `end_turn` tool. MCP tools are for
 * genuine side-effects (react/send).
 */
import { describe, it, expect, afterAll } from "vitest";
import { createStubHarness } from "./stub-harness/harness.js";
import { remoteAdapter } from "./stub-harness/adapters/remote.js";

const harness = createStubHarness(
  remoteAdapter({ id: "opencode", portEnv: "OPENCODE_PORT" }),
  { recordingSeed: 6000 },
);

describe("opencode backend — stub functional (HTTP + SSE + MCP)", () => {
  afterAll(() => harness.teardown());

  it("delivers plain assistant text (text-preferred contract)", async () => {
    harness.recording.reset();
    const replyText = `opencode-text-${Date.now()}`;

    const turn = await harness.runTurn({
      prompt: "say hello",
      turn: { emit: [{ type: "text", text: replyText }] },
    });

    expect(turn.text).toContain(replyText);
    expect(turn.durationMs).toBeGreaterThan(0);
  }, 45_000);

  it("routes an MCP tool (react) side-effect through the gateway", async () => {
    harness.recording.reset();

    const turn = await harness.runTurn({
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
    });

    expect(
      (turn.extras.mcpRegistrations as string[]).some((n) =>
        n.startsWith("talon-tools-"),
      ),
    ).toBe(true);
    expect(turn.toolUses.find((t) => t.name.endsWith("react"))).toBeDefined();
    expect(harness.recording.byAction("react").length).toBeGreaterThanOrEqual(
      1,
    );
  }, 45_000);
});
