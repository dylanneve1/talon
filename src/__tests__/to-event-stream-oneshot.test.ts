/**
 * `toOneShotEventStream` — the Phase 4 wiring bridge.
 *
 * Confirms that a legacy `runOneShotAgent(params)` function (with
 * its `appendLog` callback) becomes an `AgentEvent` stream that
 * the `AgentEventLogRenderer` (`streamLog`) can consume directly.
 *
 * Heartbeat / dream / trigger callers can opt into the shared
 * renderer by piping `toOneShotEventStream(...)` into `streamLog`
 * instead of supplying `appendLog` to the backend themselves.
 */

import { describe, expect, it } from "vitest";
import { toOneShotEventStream } from "../backend/shared/to-event-stream.js";
import { streamLog } from "../core/agent-runtime/event-log-renderer.js";
import type { OneShotAgentParams } from "../core/types.js";

function baseParams() {
  return {
    prompt: "do a thing",
    systemPrompt: "you are a helper",
    workspace: "/tmp",
    model: "stub-model",
    contextLabel: "heartbeat",
    abortController: new AbortController(),
  };
}

describe("toOneShotEventStream", () => {
  it("relays appendLog writes as assistant_message events", async () => {
    const fragments: string[] = [];
    const result = await streamLog(
      toOneShotEventStream(async (params: OneShotAgentParams) => {
        await params.appendLog("first line\n");
        await params.appendLog("second line\n");
      }, baseParams()),
      (fragment) => {
        fragments.push(fragment);
      },
    );

    expect(result?.text).toBe("");
    // Each appendLog produces one fragment. streamLog adds its own
    // newline separator inside renderAssistantMessage.
    const joined = fragments.join("");
    expect(joined).toContain("first line");
    expect(joined).toContain("second line");
    // Run-started + completed envelope rendered.
    expect(joined).toContain("Run started");
    expect(joined).toContain("Completed");
  });

  it("surfaces a thrown one-shot error as an error event", async () => {
    await expect(
      streamLog(
        toOneShotEventStream(async () => {
          throw new Error("simulated failure");
        }, baseParams()),
        () => undefined,
      ),
    ).rejects.toThrow(/Agent run failed/);
  });

  it("flushes the final appendLog write even when emitted right before completion", async () => {
    const fragments: string[] = [];
    await streamLog(
      toOneShotEventStream(async (params: OneShotAgentParams) => {
        // Emit a final message immediately before returning — the
        // wrapper must flush it before yielding `completed`.
        await params.appendLog("final note");
      }, baseParams()),
      (fragment) => {
        fragments.push(fragment);
      },
    );
    expect(fragments.join("")).toContain("final note");
  });
});
