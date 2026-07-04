/**
 * Tool-result events — the missing half of the tool lifecycle.
 *
 * The companion app opens a spinner on every `tool_call` bridge event
 * and closes it on the matching `tool_result`. No backend ever emitted
 * `tool_result`, so every tool in the app span forever. These tests
 * pin the claude-sdk extraction (real SDK tool_use ids, results parsed
 * from synthetic user messages) and the id plumbing that makes the
 * pair correlate.
 */

import { describe, it, expect } from "vitest";
import {
  processAssistantMessage,
  extractToolResults,
  isUserMessage,
  createStreamState,
} from "../backend/claude-sdk/stream.js";
import type {
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

function assistantMsg(content: unknown[]): SDKAssistantMessage {
  return {
    type: "assistant",
    message: { content },
  } as unknown as SDKAssistantMessage;
}

function userMsg(content: unknown): SDKUserMessage {
  return {
    type: "user",
    message: { content },
    parent_tool_use_id: null,
  } as unknown as SDKUserMessage;
}

describe("processAssistantMessage tool ids", () => {
  it("carries the SDK tool_use block id through to ToolCall", () => {
    const state = createStreamState();
    const result = processAssistantMessage(
      assistantMsg([
        { type: "text", text: "let me check" },
        { type: "tool_use", id: "toolu_abc123", name: "Read", input: { a: 1 } },
      ]),
      state,
    );
    expect(result.tools).toEqual([
      { id: "toolu_abc123", name: "Read", input: { a: 1 } },
    ]);
  });
});

describe("extractToolResults", () => {
  it("extracts tool_use_id for successful results (no error field)", () => {
    const results = extractToolResults(
      userMsg([
        { type: "tool_result", tool_use_id: "toolu_abc123", content: "ok" },
      ]),
    );
    expect(results).toEqual([{ toolUseId: "toolu_abc123", error: undefined }]);
  });

  it("captures error text from string and block-array content", () => {
    const results = extractToolResults(
      userMsg([
        {
          type: "tool_result",
          tool_use_id: "t1",
          is_error: true,
          content: "ENOENT: no such file",
        },
        {
          type: "tool_result",
          tool_use_id: "t2",
          is_error: true,
          content: [{ type: "text", text: "boom" }],
        },
      ]),
    );
    expect(results[0].error).toBe("ENOENT: no such file");
    expect(results[1].error).toBe("boom");
  });

  it("truncates huge error payloads to 500 chars", () => {
    const results = extractToolResults(
      userMsg([
        {
          type: "tool_result",
          tool_use_id: "t1",
          is_error: true,
          content: "x".repeat(5000),
        },
      ]),
    );
    expect(results[0].error).toHaveLength(500);
  });

  it("ignores non-tool_result blocks and malformed entries", () => {
    const results = extractToolResults(
      userMsg([
        { type: "text", text: "hi" },
        { type: "tool_result" }, // no tool_use_id
        null,
        "garbage",
      ]),
    );
    expect(results).toEqual([]);
  });

  it("handles string content (plain user message) gracefully", () => {
    expect(extractToolResults(userMsg("just text"))).toEqual([]);
  });
});

describe("isUserMessage", () => {
  it("narrows user messages and rejects others", () => {
    expect(isUserMessage(userMsg([]))).toBe(true);
    expect(isUserMessage({ type: "assistant" } as never)).toBe(false);
    expect(isUserMessage({ type: "result" } as never)).toBe(false);
  });
});
