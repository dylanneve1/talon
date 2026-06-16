/**
 * Verifies the soul surface is injected into the assembled system prompt when
 * enabled, and absent when disabled (the default).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  assembleSystemPrompt,
  joinSystemPromptParts,
} from "../core/prompt/assemble.js";
import { SoulService, setSoul, resetSoul } from "../core/soul/service.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => resetSoul());

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "soul-prompt-")), "soul.json");
}

describe("soul prompt injection", () => {
  it("omits the soul section when disabled (default)", () => {
    setSoul(SoulService.create({ enabled: false }));
    const prompt = joinSystemPromptParts(assembleSystemPrompt({}));
    expect(prompt).not.toContain("compiled identity (soul)");
  });

  it("injects the projected identity surface when enabled", () => {
    setSoul(SoulService.create({ enabled: true, path: tmpPath() }));
    const prompt = joinSystemPromptParts(assembleSystemPrompt({}));
    expect(prompt).toContain("# Talon — compiled identity (soul)");
    expect(prompt).toContain("RULE-0-DELIVERY");
  });
});
