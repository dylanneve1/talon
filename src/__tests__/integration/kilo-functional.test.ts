/**
 * Functional tests for the **kilo** backend through the production dispatcher,
 * driven by the SAME in-process fake HTTP server as opencode (kilo is an
 * opencode fork exposing the same wire API) via the shared harness. Proves the
 * one fake server + one adapter (parameterized by port env) covers both.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createStubHarness } from "./stub-harness/harness.js";
import { remoteAdapter } from "./stub-harness/adapters/remote.js";

const harness = createStubHarness(
  remoteAdapter({ id: "kilo", portEnv: "KILO_PORT" }),
  { recordingSeed: 7000 },
);

describe("kilo backend — stub functional (HTTP + SSE + MCP)", () => {
  afterAll(() => harness.teardown());

  it("delivers plain assistant text (text-preferred contract)", async () => {
    harness.recording.reset();
    const replyText = `kilo-text-${Date.now()}`;

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
