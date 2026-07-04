/**
 * Tests for shared prompt formatting.
 *
 * Every backend formats incoming user messages the same way. The format
 * is part of the public model-input contract (the system prompt teaches
 * the model what `[msg_id:N]` means etc.), so changes have to be
 * compatible across all backends.
 */

import { describe, expect, it } from "vitest";
import type { RetrievedMemory } from "../core/agent-runtime/capabilities.js";
import {
  formatPromptWithRetrievedMemory,
  formatUserPrompt,
} from "../backend/shared/prompt-format.js";

// We can't easily mock `formatFullDatetime` without setting up a vitest
// spy; instead we accept the dynamic time tag and just assert the SHAPE.

// formatFullDatetime emits `YYYY-MM-DD HH:MM <weekday-3-letter> (<tz>)`,
// e.g. `2026-05-15 11:23 Fri (UTC)`. Match that shape — we don't care
// about the specific time, only the format.
const TIME_TAG_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Za-z]{3} \([^)]+\)\] /;

describe("formatUserPrompt", () => {
  it("DM with msg_id: `[time] [msg_id:N] text`", () => {
    const out = formatUserPrompt({
      text: "hello",
      senderName: "Dylan",
      isGroup: false,
      messageId: 42,
    });
    expect(out).toMatch(TIME_TAG_RE);
    expect(out).toContain("[msg_id:42]");
    expect(out).toContain("hello");
  });

  it("group chat: `[time] [Name] [msg_id:N]: text`", () => {
    const out = formatUserPrompt({
      text: "hi all",
      senderName: "Paweł",
      isGroup: true,
      messageId: 99,
    });
    expect(out).toMatch(TIME_TAG_RE);
    expect(out).toContain("[Paweł] [msg_id:99]:");
    expect(out).toContain("hi all");
  });

  it("DM without msg_id: `[time] text`", () => {
    const out = formatUserPrompt({
      text: "no id here",
      senderName: "Dylan",
      isGroup: false,
    });
    expect(out).toMatch(TIME_TAG_RE);
    expect(out).not.toContain("[msg_id");
    expect(out).toContain("no id here");
  });

  it("group without msg_id: `[time] [Name]: text`", () => {
    const out = formatUserPrompt({
      text: "anon group msg",
      senderName: "Risen",
      isGroup: true,
    });
    expect(out).toMatch(TIME_TAG_RE);
    expect(out).toContain("[Risen]:");
    expect(out).not.toContain("[msg_id");
  });

  it("omitTimeTag drops the leading time bracket", () => {
    const out = formatUserPrompt({
      text: "no time",
      senderName: "Dylan",
      isGroup: false,
      omitTimeTag: true,
    });
    expect(out).not.toMatch(TIME_TAG_RE);
    expect(out.startsWith("[")).toBe(false);
    expect(out).toBe("no time");
  });

  it("string messageId works (Discord snowflake)", () => {
    const out = formatUserPrompt({
      text: "snowflake",
      senderName: "Dylan",
      isGroup: false,
      messageId: "1234567890123456789",
    });
    expect(out).toContain("[msg_id:1234567890123456789]");
  });
});

// ── Retrieved-memory wrapper (Phase B) ──────────────────────────────────────

function memory(
  items: RetrievedMemory["items"],
  query = "test query",
): RetrievedMemory {
  return { source: "mempalace", query, items };
}

describe("formatPromptWithRetrievedMemory", () => {
  const prompt = "[2026-07-04 20:00 Sat (UTC)] [msg_id:5] hello there";

  it("undefined memory returns the prompt byte-identical", () => {
    expect(formatPromptWithRetrievedMemory(prompt, undefined)).toBe(prompt);
  });

  it("empty item list returns the prompt byte-identical", () => {
    expect(formatPromptWithRetrievedMemory(prompt, memory([]))).toBe(prompt);
  });

  it("wraps with provenance labels and a User message section", () => {
    const out = formatPromptWithRetrievedMemory(
      prompt,
      memory([
        {
          wing: "technical",
          room: "phase-b",
          sourceFile: "notes.md",
          text: "Phase B ships inert.",
          trustLevel: "bot_inferred",
        },
        { wing: "projects", text: "Talon is the harness." },
      ]),
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("Relevant memory:");
    expect(lines[1]).toBe(
      "- [technical/phase-b notes.md] Phase B ships inert.",
    );
    expect(lines[2]).toBe("- [projects] Talon is the harness.");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("User message:");
    // The original formatted prompt survives byte-identical inside the wrapper.
    expect(out.endsWith(`User message:\n${prompt}`)).toBe(true);
  });

  it("collapses item newlines so one item stays one line", () => {
    const out = formatPromptWithRetrievedMemory(
      prompt,
      memory([{ wing: "w", text: "line one\nline two\n\tline three" }]),
    );
    expect(out).toContain("- [w] line one line two line three");
  });

  it("caps the memory block without ever touching the user message", () => {
    const long = "x".repeat(10_000);
    const out = formatPromptWithRetrievedMemory(
      prompt,
      memory([
        { wing: "a", text: long },
        { wing: "b", text: long },
      ]),
      500,
    );
    // Block obeys the cap: everything before the user message ≤ 500 chars
    // (+ the structural blank line / User message header).
    const memoryBlock = out.slice(0, out.indexOf("\n\nUser message:"));
    expect(memoryBlock.length).toBeLessThanOrEqual(500);
    expect(memoryBlock).toContain("…");
    // The user message is intact and complete.
    expect(out.endsWith(`User message:\n${prompt}`)).toBe(true);
  });

  it("is deterministic for the same inputs", () => {
    const m = memory([
      { wing: "a", room: "r", text: "t".repeat(5000) },
      { wing: "b", text: "u".repeat(5000) },
    ]);
    const first = formatPromptWithRetrievedMemory(prompt, m, 800);
    const second = formatPromptWithRetrievedMemory(prompt, m, 800);
    expect(first).toBe(second);
  });

  it("returns the prompt unchanged when the cap leaves no room for any item", () => {
    const out = formatPromptWithRetrievedMemory(
      prompt,
      memory([{ wing: "wing-name", text: "some text" }]),
      10,
    );
    expect(out).toBe(prompt);
  });
});
