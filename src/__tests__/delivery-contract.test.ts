/**
 * Delivery-contract builders + system-template renderer.
 *
 * The contract bodies live in prompts/system/contract-*.md (package-
 * owned templates); these tests exercise the real files — a template
 * regression (renamed variable, broken conditional) should fail here.
 */

import { describe, it, expect } from "vitest";
import {
  buildDeliveryContract,
  buildFlowViolationReminder,
  buildFirstTurnReminder,
  deliveryToolsForFrontend,
  registerFrontendDeliveryTools,
} from "../backend/shared/delivery-contract.js";
import { renderTemplate } from "../core/prompt/templates.js";
import { detectFlowViolation } from "../backend/shared/flow-violation.js";

describe("renderTemplate", () => {
  it("substitutes variables and drops unknowns", () => {
    expect(renderTemplate("a {{x}} b {{y}}", { x: "1" })).toBe("a 1 b ");
  });

  it("keeps {% if %} blocks only when the variable is non-empty", () => {
    const t = "start{% if flag %} kept{% endif %} end";
    expect(renderTemplate(t, { flag: "yes" })).toBe("start kept end");
    expect(renderTemplate(t, {})).toBe("start end");
    expect(renderTemplate(t, { flag: "" })).toBe("start end");
  });
});

describe("buildDeliveryContract", () => {
  it("tool-only contract names the frontend's tools (telegram)", () => {
    const c = buildDeliveryContract("tool-only", "telegram");
    expect(c).toContain("Response flow");
    expect(c).toContain("end_turn");
    expect(c).toContain("send");
    expect(c).toContain("react");
    expect(c).toContain("private scratchpad");
    expect(c).toContain("FLOW VIOLATION");
  });

  it("teams gets send_message and no react bullet", () => {
    const c = buildDeliveryContract("tool-only", "teams");
    expect(c).toContain("send_message");
    expect(c).not.toContain("react(");
  });

  it("text-or-tools contract allows plain text", () => {
    const c = buildDeliveryContract("text-or-tools", "telegram");
    expect(c).toContain("Plain text");
    expect(c).toContain("end_turn");
    expect(c).not.toContain("FLOW VIOLATION");
  });

  it("text-preferred contract steers away from tools for plain replies", () => {
    const c = buildDeliveryContract("text-preferred", "telegram");
    expect(c).toContain("plain assistant text");
    expect(c).toContain("send");
    expect(c).not.toContain("FLOW VIOLATION");
  });

  it("unknown frontends fall back to default tool names", () => {
    expect(deliveryToolsForFrontend("nope").endTurn).toBe("end_turn");
    const c = buildDeliveryContract("tool-only", "nope");
    expect(c).toContain("end_turn");
  });

  it("registerFrontendDeliveryTools extends the registry", () => {
    registerFrontendDeliveryTools("matrix", {
      endTurn: "finish_turn",
      send: "post",
    });
    const c = buildDeliveryContract("tool-only", "matrix");
    expect(c).toContain("finish_turn");
    expect(c).toContain("post");
    expect(buildFlowViolationReminder("matrix")).toContain("finish_turn");
  });
});

describe("frontend-aware reminders", () => {
  it("flow-violation reminder uses the frontend's tool names", () => {
    expect(buildFlowViolationReminder("teams")).toContain("send_message");
    expect(buildFlowViolationReminder("teams")).not.toContain("react");
    expect(buildFlowViolationReminder("telegram")).toContain("react");
  });

  it("first-turn reminder is a single bracketed line", () => {
    const r = buildFirstTurnReminder("telegram");
    expect(r.startsWith("[")).toBe(true);
    expect(r.endsWith("]")).toBe(true);
    expect(r).toContain("end_turn");
    expect(r).not.toContain("\n");
  });

  it("detectFlowViolation ships a caller-supplied reminder", () => {
    const result = detectFlowViolation({
      trailingText: "dropped prose",
      turnTerminated: false,
      deliveredTextNorms: [],
      retried: false,
      reminder: buildFlowViolationReminder("teams"),
    });
    expect(result.violated).toBe(true);
    if (result.violated) {
      expect(result.reminder).toContain("send_message");
    }
  });
});
