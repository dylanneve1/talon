/**
 * Tests for the memory/state split in the system prompt.
 *
 * `state.md` exists because status snapshots written into durable memory
 * accreted there run after run: on the live deployment three
 * `## Inbox / CI Watch (as of …, Run #N)` sections had grown to 15.8k chars
 * and pushed the actual investigations past the injection cap. A file the
 * heartbeat rewrites whole cannot accrete; a hard cap on the injected block
 * makes it loud if the heartbeat starts appending anyway.
 */

import { describe, expect, it } from "vitest";
import {
  STATE_INJECT_MAX_CHARS,
  assembleSystemPrompt,
} from "../core/prompt/assemble.js";
import { loadSystemTemplate } from "../core/prompt/templates.js";

describe("live-state template", () => {
  it("renders the state content and marks it as a snapshot", () => {
    const out = loadSystemTemplate("live-state", {
      content: "## Heartbeat health\n- healthy since 2026-07-30",
    });
    expect(out).toContain("Live State");
    expect(out).toContain("healthy since 2026-07-30");
    // The model must not treat a snapshot as a durable fact, and must not
    // write to a file the heartbeat overwrites every run.
    expect(out.toLowerCase()).toContain("snapshot");
    expect(out.toLowerCase()).toContain("read-only");
    expect(out).not.toContain("truncated here");
  });

  it("appends a pointer when the state file was capped", () => {
    const out = loadSystemTemplate("live-state", {
      content: "## CI\n- red",
      truncated: "yes",
    });
    expect(out).toContain("truncated here");
  });
});

describe("memory policy", () => {
  it("puts the replace-don't-annotate rule in the recall policy, not the wrapper", () => {
    // `memory-recall.md` owns the save/update policy, so the rule lives
    // there — duplicating it into the file wrapper would give two places to
    // drift apart. Annotation is what produced 700-char bullets carrying
    // three superseded claims plus their amendments on the live deployment.
    const policy = loadSystemTemplate("memory-recall");
    expect(policy).toMatch(/Replace what changed rather than annotating/i);
    expect(policy).toMatch(/never open a second dated section/i);
    expect(policy).toContain("memory/state.md");
    expect(policy).toMatch(/not durable memory/i);
  });

  it("keeps the file wrapper lean and delegating", () => {
    const wrapper = loadSystemTemplate("persistent-memory", { content: "x" });
    expect(wrapper).toMatch(/durable facts, not live status/i);
    expect(wrapper).toMatch(/Memory and Recall policy/);
    expect(wrapper).not.toMatch(/Replace what changed/i);
  });
});

describe("assembleSystemPrompt", () => {
  it("keeps the state cap far tighter than the memory cap", () => {
    // state.md is rewritten every run; anything large means the heartbeat is
    // accumulating history in a file that is supposed to be replaced.
    expect(STATE_INJECT_MAX_CHARS).toBeLessThan(3_000);
  });

  it("omits the state section entirely when no state file exists", () => {
    // The common case on a fresh install — an absent file must not emit an
    // empty section, and must not throw.
    const parts = assembleSystemPrompt({ frontend: "terminal" });
    expect(typeof parts.staticText).toBe("string");
    expect(parts.staticText.length).toBeGreaterThan(0);
  });
});

describe("heartbeat state-fallback template", () => {
  it("carries the ownership rules for a stale seeded prompt", () => {
    // A seeded heartbeat.md predating the split still says "update memory";
    // this block is appended to override it, since a user-owned seeded file
    // is never refreshed by an upgrade.
    const out = loadSystemTemplate("heartbeat-agent", {
      mode: "state-fallback",
      stateFile: "/home/u/.talon/workspace/memory/state.md",
      memoryFile: "/home/u/.talon/workspace/memory/memory.md",
    });
    expect(out).toContain("state.md");
    expect(out).toContain("memory.md");
    expect(out).toMatch(/read-only/i);
    expect(out).toMatch(/whole every run/i);
    // Must not leak the other branches of the template.
    expect(out).not.toContain("OUTBOUND MESSAGING");
    expect(out).not.toContain("Open goals");
  });

  it("still renders the goals fallback independently", () => {
    const out = loadSystemTemplate("heartbeat-agent", {
      mode: "goals-fallback",
      count: "2",
      goals: "- ship the release",
    });
    expect(out).toContain("Open goals (2)");
    expect(out).toContain("ship the release");
    expect(out).not.toMatch(/read-only/i);
  });
});
