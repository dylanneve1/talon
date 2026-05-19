/**
 * Tests for shared flow-violation detection.
 *
 * The fundamental contract: text-without-end_turn is a flow violation,
 * UNLESS (a) the turn was explicitly terminated by `end_turn` / `send` /
 * `react`, or (b) the text is a duplicate of something already delivered
 * through a tool call.
 *
 * `detectFlowViolation` is the single decision point — any backend that
 * implements scratchpad-by-contract calls this after its stream loop
 * ends to decide whether to issue a flow-violation reminder.
 */

import { describe, expect, it } from "vitest";
import {
  detectFlowViolation,
  FLOW_VIOLATION_REMINDER,
} from "../backend/shared/flow-violation.js";
import { normalizeForDedupe } from "../backend/shared/delivered-text.js";

describe("detectFlowViolation", () => {
  it("does NOT trigger when trailing text is empty", () => {
    const res = detectFlowViolation({
      trailingText: "",
      turnTerminated: false,
      deliveredTextNorms: [],
      retried: false,
    });
    expect(res.violated).toBe(false);
  });

  it("does NOT trigger when trailing text is whitespace only", () => {
    const res = detectFlowViolation({
      trailingText: "\n  \t ",
      turnTerminated: false,
      deliveredTextNorms: [],
      retried: false,
    });
    expect(res.violated).toBe(false);
  });

  it("does NOT trigger when turn terminated via end_turn", () => {
    const res = detectFlowViolation({
      trailingText: "Hello there, this is leftover prose",
      turnTerminated: true,
      deliveredTextNorms: [],
      retried: false,
    });
    expect(res.violated).toBe(false);
  });

  it("does NOT trigger when trailing text duplicates delivered content", () => {
    const text = "Here is your scheduled reminder";
    const res = detectFlowViolation({
      trailingText: text,
      turnTerminated: false,
      deliveredTextNorms: [normalizeForDedupe(text)],
      retried: false,
    });
    expect(res.violated).toBe(false);
  });

  it("DOES trigger when trailing text is fresh + no delivery + no termination", () => {
    const res = detectFlowViolation({
      trailingText: "The model wrote this without calling end_turn",
      turnTerminated: false,
      deliveredTextNorms: [],
      retried: false,
    });
    expect(res.violated).toBe(true);
    if (res.violated) {
      expect(res.trailing).toBe(
        "The model wrote this without calling end_turn",
      );
      expect(res.shouldRetry).toBe(true);
      expect(res.reminder).toBe(FLOW_VIOLATION_REMINDER);
    }
  });

  it("triggers but skips retry when already retried", () => {
    const res = detectFlowViolation({
      trailingText: "Still a flow violation on retry",
      turnTerminated: false,
      deliveredTextNorms: [],
      retried: true,
    });
    expect(res.violated).toBe(true);
    if (res.violated) {
      expect(res.shouldRetry).toBe(false);
    }
  });

  it("FLOW_VIOLATION_REMINDER names every delivery tool the model can use", () => {
    expect(FLOW_VIOLATION_REMINDER).toContain("FLOW VIOLATION");
    expect(FLOW_VIOLATION_REMINDER).toContain("end_turn");
    expect(FLOW_VIOLATION_REMINDER).toContain("send");
    expect(FLOW_VIOLATION_REMINDER).toContain("react");
  });
});
