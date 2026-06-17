/**
 * Tests for the decoupled-job one-shot building blocks: the pure prompt/path
 * helpers and the generic isolated-agent runner (timeout → abort → grace →
 * optional eviction).
 */

import { describe, it, expect, vi } from "vitest";
import type { BackgroundRunner } from "../core/agent-runtime/capabilities.js";
import type { OneShotAgentParams } from "../core/types.js";
import {
  buildJobSystemPrompt,
  jobSlug,
  jobLogPath,
  JOB_CONTEXT_LABEL,
} from "../core/background/job-prompt.js";
import { runIsolatedAgent } from "../core/background/isolated-agent.js";

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("job-prompt helpers", () => {
  it("builds a system prompt naming the chat and kind", () => {
    const p = buildJobSystemPrompt("123", "trigger");
    expect(p).toContain("isolated trigger job for chat 123");
    expect(p).toContain('chat_id="123"');
  });

  it("appends instructions verbatim", () => {
    const p = buildJobSystemPrompt(
      "123",
      "cron",
      "Watch the deploy; restart X.",
    );
    expect(p).toContain("Watch the deploy; restart X.");
  });

  it("slugs labels and caps length", () => {
    expect(jobSlug("My Job!! #1")).toBe("My-Job-1");
    expect(jobSlug("")).toBe("job");
    expect(jobSlug("x".repeat(100)).length).toBe(40);
  });

  it("builds a deterministic log path", () => {
    const path = jobLogPath("trigger", "err watch", 1000);
    expect(path).toMatch(/jobs\/trigger-err-watch-1000\.md$/);
  });

  it("uses the heartbeat context label for outbound tools", () => {
    expect(JOB_CONTEXT_LABEL).toBe("heartbeat");
  });
});

// ── Isolated runner ──────────────────────────────────────────────────────────

function params(): OneShotAgentParams {
  return {
    prompt: "p",
    systemPrompt: "s",
    workspace: "/tmp",
    model: "m",
    contextLabel: "heartbeat",
    abortController: new AbortController(),
    appendLog: async () => {},
  };
}

function fakeBackground(
  run: (p: OneShotAgentParams) => Promise<void>,
  evict?: BackgroundRunner["evictOrphanSubprocesses"],
): BackgroundRunner {
  return { runOneShotAgent: run, evictOrphanSubprocesses: evict };
}

describe("runIsolatedAgent", () => {
  it("resolves when the agent completes before the timeout", async () => {
    const run = vi.fn(async () => {});
    await runIsolatedAgent({
      background: fakeBackground(run),
      params: params(),
      timeoutMs: 1000,
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("propagates an agent error without aborting", async () => {
    const p = params();
    const abortSpy = vi.spyOn(p.abortController, "abort");
    await expect(
      runIsolatedAgent({
        background: fakeBackground(async () => {
          throw new Error("boom");
        }),
        params: p,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("boom");
    expect(abortSpy).not.toHaveBeenCalled();
  });

  it("aborts and throws on timeout", async () => {
    const p = params();
    const abortSpy = vi.spyOn(p.abortController, "abort");
    await expect(
      runIsolatedAgent({
        background: fakeBackground(() => new Promise<void>(() => {})),
        params: p,
        timeoutMs: 15,
        abortGraceMs: 10,
      }),
    ).rejects.toThrow(/timed out/);
    expect(abortSpy).toHaveBeenCalled();
  });

  it("evicts orphans when the backend ignores the abort and evictLabel is set", async () => {
    const evict = vi.fn(async () => ({ found: 0, termed: 0, killed: 0 }));
    await expect(
      runIsolatedAgent({
        background: fakeBackground(() => new Promise<void>(() => {}), evict),
        params: params(),
        timeoutMs: 15,
        abortGraceMs: 10,
        evictLabel: "jobs",
      }),
    ).rejects.toThrow(/timed out/);
    // give the post-grace sweep a tick to fire
    await new Promise((r) => setTimeout(r, 5));
    expect(evict).toHaveBeenCalledWith("jobs");
  });

  it("does not evict when evictLabel is unset", async () => {
    const evict = vi.fn(async () => ({ found: 0, termed: 0, killed: 0 }));
    await expect(
      runIsolatedAgent({
        background: fakeBackground(() => new Promise<void>(() => {}), evict),
        params: params(),
        timeoutMs: 15,
        abortGraceMs: 10,
      }),
    ).rejects.toThrow(/timed out/);
    await new Promise((r) => setTimeout(r, 5));
    expect(evict).not.toHaveBeenCalled();
  });
});
