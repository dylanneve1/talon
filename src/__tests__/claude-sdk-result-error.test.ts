/**
 * Result-level error capture (stream.ts processResultMessage).
 *
 * The Claude SDK doesn't throw on API errors — usage limits, 429s and
 * auth failures arrive as a synthetic assistant message plus a result
 * flagged `is_error` (subtype "success") or an error subtype. These
 * tests pin that both shapes populate `state.resultErrorText` with the
 * real error text so the handler fails the turn verbosely instead of
 * treating it as a normal (empty) reply.
 */

import { describe, it, expect } from "vitest";
import {
  createStreamState,
  processResultMessage,
} from "../backend/claude-sdk/stream.js";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

const LIMIT_TEXT = "You've hit your weekly limit · resets Jul 10, 9am";

function successResult(
  overrides: Partial<Record<string, unknown>> = {},
): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1000,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 1,
    result: "hello",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "s",
    ...overrides,
  } as unknown as SDKResultMessage;
}

describe("processResultMessage error capture", () => {
  it("leaves resultErrorText unset on a clean success", () => {
    const state = createStreamState();
    processResultMessage(successResult(), state, "opus");
    expect(state.resultErrorText).toBeUndefined();
  });

  it("captures the API error text from an is_error success result (usage limit)", () => {
    const state = createStreamState();
    processResultMessage(
      successResult({ is_error: true, result: LIMIT_TEXT }),
      state,
      "opus",
    );
    expect(state.resultErrorText).toBe(LIMIT_TEXT);
  });

  it("falls back to the trailing assistant text when an is_error result has no text", () => {
    const state = createStreamState();
    state.lastTrailingText = LIMIT_TEXT;
    processResultMessage(
      successResult({ is_error: true, result: "" }),
      state,
      "opus",
    );
    expect(state.resultErrorText).toBe(LIMIT_TEXT);
  });

  it("captures diagnostics from an error-subtype result", () => {
    const state = createStreamState();
    processResultMessage(
      successResult({
        subtype: "error_during_execution",
        is_error: true,
        result: undefined,
        errors: ["[ede_diagnostic] result_type=x", "spawn ENOENT"],
      }),
      state,
      "opus",
    );
    expect(state.resultErrorText).toBe("spawn ENOENT");
  });

  it("names the subtype when an error result carries no usable text", () => {
    const state = createStreamState();
    processResultMessage(
      successResult({
        subtype: "error_max_turns",
        is_error: true,
        result: undefined,
        errors: [],
      }),
      state,
      "opus",
    );
    expect(state.resultErrorText).toBe(
      "Claude SDK turn failed (error_max_turns)",
    );
  });
});
