/**
 * Functional tests for the **codex** backend through the production dispatcher,
 * driven by the stub `codex` binary (`stub-codex/fake-codex.mjs`) via the
 * shared multi-backend harness.
 *
 * codex's transport: the @openai/codex-sdk spawns `codex exec
 * --experimental-json` once per turn and reads ThreadEvent JSONL from stdout.
 * Delivery is via the `end_turn` MCP tool (like claude).
 *
 * Skipped on Windows: the stub is a `.mjs` driven by a shebang + exec bit,
 * which `spawn(executablePath)` can't launch on Windows (CVE-2024-27980). The
 * claude functional suite skips there for the same reason (it needs a separate
 * SEA `.exe` build). The other backends' stubs are in-process HTTP servers and
 * run cross-platform.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createStubHarness } from "./stub-harness/harness.js";
import { codexAdapter } from "./stub-harness/adapters/codex.js";
import { mcpToolCall } from "./stub-codex/helpers.js";

const codexStubRunnable = process.platform !== "win32";
const harness = createStubHarness(codexAdapter(), { recordingSeed: 5000 });

describe.skipIf(!codexStubRunnable)(
  "codex backend — stub functional (MCP + gateway)",
  () => {
    afterAll(() => harness.teardown());

    it("delivers text via end_turn MCP tool → gateway send_message", async () => {
      harness.recording.reset();
      const replyText = `codex-functional-${Date.now()}`;

      const turn = await harness.runTurn({
        prompt: "say hello",
        turn: {
          dispatchMcp: true,
          emit: [
            mcpToolCall("telegram-tools", "end_turn", { text: replyText }),
          ],
        },
      });

      const endTurnCall = turn.toolUses.find((t) =>
        t.name.endsWith("end_turn"),
      );
      expect(endTurnCall, "expected an end_turn tool use").toBeDefined();

      const sends = harness.recording.byAction("send_message");
      expect(sends.length).toBeGreaterThanOrEqual(1);
      expect(sends[0].body.text).toBe(replyText);

      const mcpLines = (turn.extras.protocolLog as string[]).filter((l) =>
        l.includes("MCP tools/call"),
      );
      expect(mcpLines.length).toBeGreaterThanOrEqual(1);
    }, 45_000);

    it("surfaces a non-delivery mcp_tool_call via onToolUse", async () => {
      harness.recording.reset();

      const turn = await harness.runTurn({
        prompt: "react please",
        turn: {
          dispatchMcp: true,
          emit: [
            mcpToolCall("telegram-tools", "react", {
              message_id: 1,
              emoji: "👍",
            }),
          ],
        },
      });

      expect(turn.toolUses.find((t) => t.name.endsWith("react"))).toBeDefined();
      expect(harness.recording.byAction("react").length).toBeGreaterThanOrEqual(
        1,
      );
    }, 45_000);

    it("returns usage + completes on a prose-only turn (no delivery tool)", async () => {
      harness.recording.reset();

      const turn = await harness.runTurn({
        prompt: "just think",
        turn: {
          emit: [{ type: "agent_message", text: "internal reasoning text" }],
        },
      });

      expect(turn.text).toContain("internal reasoning text");
      expect(turn.durationMs).toBeGreaterThan(0);
    }, 45_000);
  },
);
