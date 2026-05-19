/**
 * Tests for system-prompt assembly — backend suffix append + first-turn
 * rebuild. `prepareSystemPrompt` is tested implicitly via the backends'
 * handler tests (it mutates config in place); `appendBackendSuffix` is
 * pure and gets unit-tested here.
 */

import { describe, expect, it } from "vitest";
import { appendBackendSuffix } from "../backend/shared/system-prompt.js";

describe("appendBackendSuffix", () => {
  it("returns base when suffix is undefined", () => {
    expect(appendBackendSuffix("base prompt", undefined)).toBe("base prompt");
  });

  it("returns base when suffix is empty", () => {
    expect(appendBackendSuffix("base prompt", "")).toBe("base prompt");
    expect(appendBackendSuffix("base prompt", "   ")).toBe("base prompt");
  });

  it("returns suffix when base is empty", () => {
    expect(appendBackendSuffix("", "suffix only")).toBe("suffix only");
    expect(appendBackendSuffix("   ", "suffix only")).toBe("suffix only");
  });

  it("returns empty string when both are empty", () => {
    expect(appendBackendSuffix("", "")).toBe("");
    expect(appendBackendSuffix("   ", "   ")).toBe("");
  });

  it("joins base + suffix with double newline", () => {
    expect(appendBackendSuffix("base", "suffix")).toBe("base\n\nsuffix");
  });

  it("trims base and suffix before joining", () => {
    expect(appendBackendSuffix("  base  ", "  suffix  ")).toBe(
      "base\n\nsuffix",
    );
  });

  it("idempotent on null-ish base", () => {
    // @ts-expect-error - testing defensive null handling
    expect(appendBackendSuffix(null, "x")).toBe("x");
    // @ts-expect-error - testing defensive null handling
    expect(appendBackendSuffix(undefined, "x")).toBe("x");
  });
});
