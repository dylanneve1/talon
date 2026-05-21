import { describe, expect, it } from "vitest";
import { buildContextDisplay } from "../frontend/status-context.js";

describe("status context display", () => {
  it("uses authoritative contextTokens when present", () => {
    const display = buildContextDisplay({
      contextTokens: 80_000,
      lastPromptTokens: 12_800_000,
      contextWindow: 100_000,
    });

    expect(display.known).toBe(true);
    expect(display.used).toBe(80_000);
    expect(display.pct).toBe(80);
    expect(display.warn).toBe(true);
  });

  it("uses lastPromptTokens as a fallback only when it fits in the window", () => {
    const display = buildContextDisplay({
      contextTokens: 0,
      lastPromptTokens: 120_000,
      contextWindow: 272_000,
    });

    expect(display.known).toBe(true);
    expect(display.used).toBe(120_000);
    expect(display.pct).toBe(44);
  });

  it("does not present impossible cached/cumulative usage as context fill", () => {
    const display = buildContextDisplay({
      contextTokens: 0,
      lastPromptTokens: 12_800_000,
      contextWindow: 272_000,
    });

    expect(display.known).toBe(false);
    expect(display.used).toBe(0);
    expect(display.pct).toBe(0);
    expect(display.warn).toBe(false);
    expect(display.bar).toBe("░".repeat(20));
  });
});
