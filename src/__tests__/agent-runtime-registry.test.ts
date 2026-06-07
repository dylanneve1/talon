/**
 * Phase 3 prep tests — `BackendRegistry` shim
 * (`agent-runtime/registry.ts`).
 *
 * The shim adapts the existing legacy `BackendFactory` registry
 * into `Backend` composed objects via `adaptQueryBackend`. Pins:
 *
 *   - `getAdaptedBackends` initialises every registered factory
 *     exactly once and wraps the result.
 *   - Factories whose id is not in `BACKEND_IDS` are skipped
 *     (with a console warning).
 *   - `adaptOneBackend` returns `null` for unknown ids.
 *   - `adaptInstantiatedBackend` works without going through the
 *     registry init() step.
 *
 * Uses the legacy registry's `registerBackend` + `clearBackends`
 * test hooks — same isolation pattern as the existing
 * `backend-registry-parity.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  clearBackends,
  registerBackend,
  type BackendInitContext,
  type BackendInstance,
} from "../backend/registry.js";
import {
  adaptInstantiatedBackend,
  adaptOneBackend,
  getAdaptedBackends,
} from "../core/agent-runtime/registry.js";
import type { QueryBackend } from "../core/types.js";
import type { TalonConfig } from "../util/config.js";

function stubBackend(): QueryBackend {
  return {
    query: vi.fn(async () => ({
      text: "",
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })),
    cacheMetrics: "readwrite",
  } as QueryBackend;
}

function stubFactory(id: string, label: string) {
  const backend = stubBackend();
  const init = vi.fn(
    async (
      _c: TalonConfig,
      _x: BackendInitContext,
    ): Promise<BackendInstance> => ({ backend }),
  );
  return { id, label, init, backend };
}

const ctx: BackendInitContext = {
  getBridgePort: () => 0,
  frontendName: "terminal",
};

const fakeConfig = {} as TalonConfig;

beforeEach(() => {
  clearBackends();
});

// ── getAdaptedBackends ──────────────────────────────────────────────────────

describe("getAdaptedBackends", () => {
  it("adapts every registered factory whose id is in BACKEND_IDS", async () => {
    const claude = stubFactory("claude", "Claude SDK");
    const codex = stubFactory("codex", "Codex");
    registerBackend(claude);
    registerBackend(codex);

    const backends = await getAdaptedBackends(fakeConfig, ctx);
    expect(backends.map((b) => b.id).sort()).toEqual(["claude", "codex"]);
    expect(claude.init).toHaveBeenCalledTimes(1);
    expect(codex.init).toHaveBeenCalledTimes(1);
    for (const b of backends) {
      expect(b.chat).toBeDefined();
      expect(b.capabilities.chat).toBe(true);
    }
  });

  it("skips factories whose id is not in BACKEND_IDS with a console warning", async () => {
    const claude = stubFactory("claude", "Claude SDK");
    const ghost = stubFactory("ghost-backend", "Ghost");
    registerBackend(claude);
    registerBackend(ghost);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backends = await getAdaptedBackends(fakeConfig, ctx);
    expect(backends.map((b) => b.id)).toEqual(["claude"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Skipping backend "ghost-backend"`),
    );
    expect(ghost.init).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns an empty array when the registry is empty", async () => {
    const backends = await getAdaptedBackends(fakeConfig, ctx);
    expect(backends).toEqual([]);
  });

  it("forwards adapter options through to the wrapped backend", async () => {
    const sink = vi.fn();
    const claude = stubFactory("claude", "Claude");
    // Make the legacy backend implement runOneShotAgent so the
    // adapter populates the background slot AND threads logSink.
    claude.backend.runOneShotAgent = vi.fn(async (params) => {
      await params.appendLog("hi");
    });
    registerBackend(claude);

    const [adapted] = await getAdaptedBackends(fakeConfig, ctx, {
      logSink: sink,
    });
    expect(adapted.background).toBeDefined();
    const stream = adapted.background!.runBackgroundTask({
      prompt: "",
      systemPrompt: "",
      workspace: "/tmp",
      model: { backend: "claude", id: "x" } as never,
      policy: {} as never,
      contextLabel: "heartbeat",
      abortController: new AbortController(),
    });
    for await (const _ of stream) {
      /* drain */
    }
    expect(sink).toHaveBeenCalledWith("hi");
  });
});

// ── adaptOneBackend ────────────────────────────────────────────────────────

describe("adaptOneBackend", () => {
  it("returns the adapted Backend for the named id", async () => {
    const claude = stubFactory("claude", "Claude");
    registerBackend(claude);
    const adapted = await adaptOneBackend("claude", fakeConfig, ctx);
    expect(adapted).not.toBeNull();
    expect(adapted!.id).toBe("claude");
    expect(claude.init).toHaveBeenCalledTimes(1);
  });

  it("returns null when no factory is registered for the id", async () => {
    const adapted = await adaptOneBackend("codex", fakeConfig, ctx);
    expect(adapted).toBeNull();
  });
});

// ── adaptInstantiatedBackend ───────────────────────────────────────────────

describe("adaptInstantiatedBackend", () => {
  it("wraps an existing BackendInstance without going through init", () => {
    const backend = stubBackend();
    const instance: BackendInstance = { backend };
    const adapted = adaptInstantiatedBackend(instance, "kilo", "Kilo");
    expect(adapted.id).toBe("kilo");
    expect(adapted.label).toBe("Kilo");
    expect(adapted.chat).toBeDefined();
  });
});
