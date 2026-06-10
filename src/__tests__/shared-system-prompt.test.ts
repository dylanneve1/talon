/**
 * Tests for system-prompt assembly — per-session snapshot freezing,
 * the static/dynamic split, and backend suffix append.
 *
 * The snapshot suite covers the cross-chat cache-invalidation bug:
 * before snapshots, any chat starting a fresh session rebuilt the
 * global `config.systemPrompt` in place and every other in-flight
 * session picked up the new string mid-conversation, invalidating its
 * provider prompt-cache prefix.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendBackendSuffix,
  clearSystemPromptSnapshots,
  prepareSystemPrompt,
} from "../backend/shared/system-prompt.js";
import { rebuildSystemPrompt, type TalonConfig } from "../util/config.js";

// Each rebuild stamps a fresh version into the config — simulating the
// real volatility (workspace listing sizes, daily-memory pointer) that
// makes consecutive rebuilds differ.
let rebuildCount = 0;

vi.mock("../util/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../util/config.js")>();
  return {
    ...orig,
    rebuildSystemPrompt: vi.fn((config: { [k: string]: unknown }) => {
      rebuildCount += 1;
      config.systemPromptParts = {
        staticText: `static v${rebuildCount}`,
        dynamicText: `dynamic v${rebuildCount}`,
      };
      config.systemPrompt = `static v${rebuildCount}\n\n---\n\ndynamic v${rebuildCount}`;
    }),
  };
});

vi.mock("../core/plugin.js", () => ({
  getPluginPromptAdditions: () => [],
}));

function makeConfig(): TalonConfig {
  return {
    systemPrompt: "initial",
    systemPromptParts: { staticText: "initial", dynamicText: "" },
  } as unknown as TalonConfig;
}

describe("prepareSystemPrompt per-session snapshots", () => {
  beforeEach(() => {
    clearSystemPromptSnapshots();
    rebuildCount = 0;
    vi.mocked(rebuildSystemPrompt).mockClear();
  });

  it("freezes the prompt for a session epoch (rebuilds exactly once)", () => {
    const config = makeConfig();
    const first = prepareSystemPrompt({
      config,
      previousTurns: 0,
      chatId: "chat-a",
      sessionEpoch: 1000,
    });
    const second = prepareSystemPrompt({
      config,
      previousTurns: 1,
      chatId: "chat-a",
      sessionEpoch: 1000,
    });

    expect(rebuildSystemPrompt).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first.staticText).toBe("static v1");
    expect(first.dynamicText).toBe("dynamic v1");
  });

  it("rebuilds when the session epoch changes (session reset)", () => {
    const config = makeConfig();
    const first = prepareSystemPrompt({
      config,
      previousTurns: 0,
      chatId: "chat-a",
      sessionEpoch: 1000,
    });
    const afterReset = prepareSystemPrompt({
      config,
      previousTurns: 0,
      chatId: "chat-a",
      sessionEpoch: 2000,
    });

    expect(rebuildSystemPrompt).toHaveBeenCalledTimes(2);
    expect(afterReset.staticText).toBe("static v2");
    expect(afterReset).not.toBe(first);
  });

  it("another chat's fresh session does NOT change an in-flight session's prompt", () => {
    const config = makeConfig();
    // Chat A starts a session and snapshots v1.
    const a1 = prepareSystemPrompt({
      config,
      previousTurns: 0,
      chatId: "chat-a",
      sessionEpoch: 1000,
    });
    // Chat B starts a fresh session — rebuilds the global template (v2).
    prepareSystemPrompt({
      config,
      previousTurns: 0,
      chatId: "chat-b",
      sessionEpoch: 5000,
    });
    expect(config.systemPromptParts?.staticText).toBe("static v2");

    // Chat A's next turn still gets its frozen v1 prompt — byte-identical,
    // so its provider cache prefix survives.
    const a2 = prepareSystemPrompt({
      config,
      previousTurns: 7,
      chatId: "chat-a",
      sessionEpoch: 1000,
    });
    expect(a2.staticText).toBe("static v1");
    expect(a2.text).toBe(a1.text);
  });

  it("clearSystemPromptSnapshots forces a rebuild on next turn", () => {
    const config = makeConfig();
    prepareSystemPrompt({
      config,
      previousTurns: 0,
      chatId: "chat-a",
      sessionEpoch: 1000,
    });
    clearSystemPromptSnapshots();
    const after = prepareSystemPrompt({
      config,
      previousTurns: 3,
      chatId: "chat-a",
      sessionEpoch: 1000,
    });

    expect(rebuildSystemPrompt).toHaveBeenCalledTimes(2);
    expect(after.staticText).toBe("static v2");
  });

  it("a different backend suffix re-freezes (backend switch mid-session)", () => {
    const config = makeConfig();
    const first = prepareSystemPrompt({
      config,
      previousTurns: 0,
      chatId: "chat-a",
      sessionEpoch: 1000,
      backendSuffix: "use end_turn",
    });
    expect(first.staticText).toBe("static v1\n\nuse end_turn");

    const switched = prepareSystemPrompt({
      config,
      previousTurns: 1,
      chatId: "chat-a",
      sessionEpoch: 1000,
      backendSuffix: "return text",
    });
    expect(switched.staticText).toBe("static v2\n\nreturn text");
  });

  it("appends the backend suffix to the static part, never the dynamic part", () => {
    const config = makeConfig();
    const prepared = prepareSystemPrompt({
      config,
      previousTurns: 0,
      chatId: "chat-a",
      sessionEpoch: 1000,
      backendSuffix: "delivery contract",
    });
    expect(prepared.staticText).toBe("static v1\n\ndelivery contract");
    expect(prepared.dynamicText).toBe("dynamic v1");
    expect(prepared.text).toBe(
      "static v1\n\ndelivery contract\n\n---\n\ndynamic v1",
    );
  });

  it("legacy path (no chatId): rebuilds on first turn only", () => {
    const config = makeConfig();
    const first = prepareSystemPrompt({ config, previousTurns: 0 });
    expect(rebuildSystemPrompt).toHaveBeenCalledTimes(1);
    expect(first.staticText).toBe("static v1");

    const second = prepareSystemPrompt({ config, previousTurns: 1 });
    expect(rebuildSystemPrompt).toHaveBeenCalledTimes(1);
    // Legacy path reads the live config — no snapshot identity.
    expect(second.staticText).toBe("static v1");
  });

  it("falls back to all-static when config lacks systemPromptParts", () => {
    const config = {
      systemPrompt: "string-only prompt",
    } as unknown as TalonConfig;
    const prepared = prepareSystemPrompt({ config, previousTurns: 1 });
    expect(prepared.staticText).toBe("string-only prompt");
    expect(prepared.dynamicText).toBe("");
    expect(prepared.text).toBe("string-only prompt");
  });
});

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
