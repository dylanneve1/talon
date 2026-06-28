/**
 * Tests for the decoupled-job one-shot building blocks: the pure prompt/path
 * helpers and the generic isolated-agent runner (timeout → abort → grace →
 * optional eviction).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { basename } from "node:path";
import type {
  Backend,
  BackgroundRunner,
} from "../core/agent-runtime/capabilities.js";
import { composeBackend } from "../core/agent-runtime/capabilities.js";
import {
  clearBackends,
  registerBackend,
  type BackendFactory,
} from "../core/agent-runtime/backend-registry.js";
import type { OneShotAgentParams } from "../core/types.js";
import {
  buildJobSystemPrompt,
  jobSlug,
  jobLogPath,
  JOB_CONTEXT_LABEL,
} from "../core/background/job-prompt.js";
import { runIsolatedAgent } from "../core/background/isolated-agent.js";
import { runJobOneShot } from "../core/background/job-oneshot.js";
import {
  cleanupBackendPool,
  initBackendPool,
  resetBackendPoolForTest,
} from "../core/engine/backend-controller/index.js";
import type { TalonConfig } from "../util/config.js";

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

  it("builds a deterministic log file name", () => {
    // Assert on the basename so the test is path-separator agnostic (Windows
    // uses backslashes, which a `jobs/...` regex would miss).
    expect(basename(jobLogPath("trigger", "err watch", 1000))).toBe(
      "trigger-err-watch-1000.md",
    );
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

function backendFactory(
  id: string,
  backend: Backend,
  cleanup?: () => void,
): BackendFactory {
  return {
    id,
    label: id,
    async init() {
      return { backend, cleanup };
    },
  };
}

const STUB_CONFIG = { backend: "claude" } as unknown as TalonConfig;
const STUB_CTX = {
  getBridgePort: () => 0,
  frontendName: "terminal" as const,
};

beforeEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
});

afterEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackends();
});

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

describe("runJobOneShot", () => {
  it("acquires, runs, and releases a transient backend once", async () => {
    const run = vi.fn(async (_params: OneShotAgentParams) => {});
    const cleanup = vi.fn();
    registerBackend(
      backendFactory(
        "claude",
        composeBackend({ id: "claude", label: "claude" }),
      ),
    );
    registerBackend(
      backendFactory(
        "codex",
        composeBackend({
          id: "codex",
          label: "codex",
          background: fakeBackground(run),
        }),
        cleanup,
      ),
    );
    await initBackendPool(STUB_CONFIG, STUB_CTX);

    const result = await runJobOneShot({
      chatId: "42",
      backendId: "codex",
      model: "model-ok",
      payload: "payload",
      label: "nightly check",
      kind: "cron",
      timeoutMs: 1000,
    });

    expect(result).toEqual({ status: "ran" });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      prompt: "payload",
      model: "model-ok",
      contextLabel: JOB_CONTEXT_LABEL,
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
