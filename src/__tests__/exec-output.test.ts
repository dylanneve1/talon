/**
 * Exec output guards — the shared capture/render ceilings under both the
 * local native tools and the mesh exec channel. Without them a runaway
 * `yes` balloons daemon memory for the whole timeout window, and a chatty
 * device command floods the chat/model with megabytes of output.
 */

import { describe, expect, it } from "vitest";
import {
  clampExecOutput,
  createOutputCapture,
  MAX_EXEC_RENDER_CHARS,
} from "../util/exec-output.js";

describe("clampExecOutput", () => {
  it("passes short output through untouched", () => {
    expect(clampExecOutput("hello")).toBe("hello");
  });

  it("keeps head and tail, elides the middle with an explicit marker", () => {
    const text = `HEAD${"x".repeat(100_000)}TAIL`;
    const clamped = clampExecOutput(text);
    expect(clamped.length).toBeLessThan(MAX_EXEC_RENDER_CHARS + 200);
    expect(clamped.startsWith("HEAD")).toBe(true);
    expect(clamped.endsWith("TAIL")).toBe(true);
    expect(clamped).toContain("chars truncated");
  });
});

describe("createOutputCapture", () => {
  it("accumulates chunks below the cap verbatim", () => {
    const cap = createOutputCapture();
    cap.push("one ");
    cap.push(Buffer.from("two"));
    expect(cap.value()).toBe("one two");
  });

  it("stops storing past the cap and reports the dropped volume", () => {
    const cap = createOutputCapture(10);
    cap.push("0123456789");
    cap.push("overflow!");
    const value = cap.value();
    expect(value.startsWith("0123456789")).toBe(true);
    expect(value).toContain("more chars dropped");
    expect(value).not.toContain("overflow!");
  });

  it("splits a chunk that straddles the cap", () => {
    const cap = createOutputCapture(5);
    cap.push("abcdefgh");
    expect(cap.value().startsWith("abcde")).toBe(true);
    expect(cap.value()).toContain("dropped");
  });
});
